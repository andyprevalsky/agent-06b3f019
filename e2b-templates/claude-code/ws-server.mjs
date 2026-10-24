#!/usr/bin/env node
/**
 * WebSocket server that runs Claude Code CLI and streams both
 * readable output and normalized JSON events.
 */

import { WebSocketServer } from "ws";
import { execFileSync, execSync, spawn } from "child_process";
import { randomUUID, timingSafeEqual } from "crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// Log to both console and file for debugging
const LOG_FILE = "/tmp/ws-server.log";
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({ timestamp, level, message, ...data });
  console.log(logLine);
  try {
    appendFileSync(LOG_FILE, logLine + "\n");
  } catch (e) {
    // Ignore file write errors
  }
}

// E2B template defaults to 3000; local fallback overrides via PORT.
const rawPort = process.env.PORT || "3000";
if (!/^\d+$/.test(rawPort)) {
  log("error", "Invalid PORT — require a complete decimal value", {
    port: rawPort,
  });
  process.exit(1);
}
const PORT = Number.parseInt(rawPort, 10);
if (PORT < 0 || PORT > 65535) {
  log("error", "PORT out of range (0–65535)", { port: PORT });
  process.exit(1);
}
const GOAL = process.env.CLAUDE_CODE_GOAL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_CODE_CREDENTIALS = process.env.CLAUDE_CODE_CREDENTIALS;
const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const CLAUDE_CODE_FAST_MODE = process.env.CLAUDE_CODE_FAST_MODE === "1";
const CLAUDE_CODE_MODEL = process.env.CLAUDE_CODE_MODEL || "claude-sonnet-5";
const CODE_AGENT_SYSTEM_PROMPT = process.env.CODE_AGENT_SYSTEM_PROMPT || "";
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Project sessions (backend restoreWorkspace): the checkout is already in
// ~/workspace with its env files; run the project's startup script before the
// CLI on every boot (create and resume) and tell the CLI how it went.
const PROJECT_WORKDIR = process.env.ROSE_PROJECT_WORKDIR || "";
const PROJECT_STARTUP = process.env.ROSE_PROJECT_STARTUP || "";
const PROJECT_STARTUP_CONFIG = process.env.ROSE_PROJECT_STARTUP_CONFIG || "";
const PROJECT_NAME = process.env.ROSE_PROJECT_NAME || "";
const PROJECT_STARTUP_REPORT_PREFIX = "ROSE_PROJECT_STARTUP_REPORT ";

// Validate required env vars
if (
  !ANTHROPIC_API_KEY &&
  !CLAUDE_CODE_CREDENTIALS &&
  !CLAUDE_CODE_OAUTH_TOKEN
) {
  log("error", "No Claude auth configured");
  process.exit(1);
}
if (!GOAL) {
  log("error", "CLAUDE_CODE_GOAL not set");
  process.exit(1);
}

// Buffer to accumulate all stdout (never flushed)
let outputBuffer = "";
let eventBuffer = [];

// Track connected clients
const clients = new Set();

// After the CLI exits the server keeps serving its final buffer until the
// session is closed, so an agent activity that detached for a deploy (or
// crashed and is retried after its heartbeat timeout) can always reattach and
// read the result. There is no linger deadline: an unattended sandbox pauses
// on its E2B idle window and the result is still here when it resumes.
// Closing the session (SIGTERM / sandbox pause or kill) exits immediately.

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  log("info", "Server listening", {
    port: wss.address().port,
    ...(process.env.ROSE_LOCAL_WS_READINESS_TOKEN
      ? { readinessToken: process.env.ROSE_LOCAL_WS_READINESS_TOKEN }
      : {}),
  });
});

// A control connection that only sends a turn (`?replay=0`) skips the history
// replay: a long session's buffer is megabytes, and the turn ack would queue
// behind it on every typed message.
function wantsReplay(req) {
  try {
    return (
      new URL(req?.url || "/", "http://localhost").searchParams.get(
        "replay",
      ) !== "0"
    );
  } catch {
    return true;
  }
}

wss.on("connection", (ws, req) => {
  // Send full buffer to new client
  const replay = wantsReplay(req);
  if (replay && outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: "buffer", data: outputBuffer }));
  }
  if (replay && eventBuffer.length > 0) {
    const rawCursor = new URL(
      req?.url || "/",
      "http://localhost",
    ).searchParams.get("cursor");
    const cursor =
      rawCursor !== null && /^\d+$/.test(rawCursor) ? Number(rawCursor) : -1;
    ws.send(
      JSON.stringify({
        type: "code_agent_events",
        data: eventBuffer.filter((event) => event.seq > cursor),
      }),
    );
  }
  if (exitAnnounced) {
    log("info", "Served final buffer to reattaching client");
    ws.send(exitMessage(finalExitCode));
    ws.close();
    return;
  }

  clients.add(ws);
  log("info", "Client connected", { total: clients.size });

  // Handle incoming messages (stdin from parent agent)
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "stdin") {
        log("info", "Received stdin", { bytes: msg.data?.length || 0 });

        if (!msg.data) {
          ws.send(
            JSON.stringify({
              type: "stdin_error",
              error: "Missing data field",
            }),
          );
          return;
        }

        // Raw stdin stays closed to callers: only authenticated, idempotent
        // `user_turn` messages reach the CLI (see handleUserTurn).
        ws.send(
          JSON.stringify({
            type: "stdin_error",
            error: "Raw stdin is disabled; send an authenticated user_turn",
          }),
        );
      } else if (msg.type === "user_turn") {
        void handleUserTurn(msg)
          .then((ack) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(ack));
          })
          .catch((error) => {
            if (ws.readyState === 1)
              ws.send(
                JSON.stringify(turnAck(msg.id, "rejected", error.message)),
              );
          });
      } else if (msg.type === "session_capabilities") {
        if (!tokenMatches(msg.token))
          ws.send(
            JSON.stringify({
              type: "session_capabilities_ack",
              status: "rejected",
              reason: "unauthorized",
            }),
          );
        else
          void sessionCapabilities()
            .then((caps) => {
              if (ws.readyState === 1)
                ws.send(
                  JSON.stringify({
                    type: "session_capabilities_ack",
                    status: "delivered",
                    ...caps,
                  }),
                );
            })
            .catch((error) => {
              if (ws.readyState === 1)
                ws.send(
                  JSON.stringify({
                    type: "session_capabilities_ack",
                    status: "rejected",
                    reason: error.message,
                  }),
                );
            });
      } else if (msg.type === "hand_back") {
        ws.send(JSON.stringify(handleHandBack(msg)));
      }
    } catch (e) {
      log("error", "Failed to parse message", { error: e.message });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    log("info", "Client disconnected", { total: clients.size });
  });

  ws.on("error", (err) => {
    log("error", "Client error", { error: err.message });
    clients.delete(ws);
  });
});

// Broadcast to all connected clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      client.send(message);
    }
  }
}

function appendOutput(type, data) {
  outputBuffer += data;
  broadcast(type, data);
}

// Startup branch events can be emitted before the native CLI is initialized.
let activeTurn = null;

function appendEvent(event) {
  const normalized = {
    version: 1,
    provider: "claude",
    timestamp: new Date().toISOString(),
    seq: eventBuffer.length,
    ...(activeTurn
      ? { turn_id: activeTurn.id, turn_started_at: activeTurn.startedAt }
      : {}),
    ...event,
  };
  eventBuffer.push(normalized);
  broadcast("code_agent_event", normalized);
}

// Handle shutdown gracefully
let processExited = false;
let shuttingDown = false;
let exitAnnounced = false;
let finalExitCode = 0;
let servingFinalBuffer = false;

function exitMessage(exitCode) {
  // Sent directly, not wrapped in data
  return JSON.stringify({ type: "exit", code: exitCode });
}

function announceExit(exitCode) {
  // Idempotent: the child close handler, the child error handler, and a
  // signal can all race to end the run. Only the first records the result.
  if (exitAnnounced) return;
  exitAnnounced = true;
  finalExitCode = exitCode;
  appendEvent({
    type: "final",
    status: exitCode === 0 ? "completed" : "failed",
    exit_code: exitCode,
  });
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(exitMessage(exitCode));
    }
    client.close();
  }
}

function finishRun(exitCode) {
  announceExit(exitCode);
  if (servingFinalBuffer || shuttingDown) return;
  servingFinalBuffer = true;
  log("info", "Serving final buffer for reattach until closed", { exitCode });
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Starting graceful shutdown", { exitCode });
  endNativeTurn("interrupted");
  if (cliChild && !processExited) cliChild.kill("SIGTERM");

  announceExit(exitCode);

  // Close server
  wss.close(() => {
    log("info", "Shutdown complete");
    process.exit(exitCode);
  });

  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    log("error", "Forced exit after timeout");
    process.exit(exitCode);
  }, 5000);
}

// Handle signals
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Pre-configure Claude Code to skip all prompts
log("info", "Configuring Claude Code");

const home = homedir();
const attachmentsDir = join(home, "attachments");
const outputDir = join(home, "output");
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(attachmentsDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

const config = {
  theme: "dark",
  hasCompletedOnboarding: true,
  bypassPermissionsModeAccepted: true,
  autoUpdaterStatus: "disabled",
  shiftEnterKeyBindingInstalled: true,
};

// Per-user credentials: write ~/.claude/.credentials.json
// API key mode: add customApiKeyResponses to config
if (CLAUDE_CODE_CREDENTIALS) {
  log("info", "Using per-user credentials");
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    CLAUDE_CODE_CREDENTIALS,
  );
} else if (CLAUDE_CODE_OAUTH_TOKEN) {
  log("info", "Using Claude OAuth token");
} else {
  log("info", "Using shared API key");
  const apiKeyLast20 = ANTHROPIC_API_KEY.slice(-20);
  config.customApiKeyResponses = {
    approved: [apiKeyLast20],
    rejected: [],
  };
}

// Trust configuration: write in BOTH legacy and modern formats so any
// Claude Code version recognises the workspace as trusted.
const projects = {
  [home]: { allowedTools: ["*"], hasTrustDialogAccepted: true },
  "/": { allowedTools: ["*"], hasTrustDialogAccepted: true },
};

writeFileSync(join(home, ".claude.json"), JSON.stringify(config));
writeFileSync(join(home, ".claude", "projects.json"), JSON.stringify(projects));

// Modern per-project settings: Claude Code >= 1.x stores trust per directory
// in ~/.claude/settings.json under an allowedDirectories array.
const settingsPath = join(home, ".claude", "settings.json");
const settings = {
  allowedDirectories: [home, "/"],
  ...(CLAUDE_CODE_FAST_MODE ? { fastMode: true } : {}),
};
writeFileSync(settingsPath, JSON.stringify(settings));

log("info", "Configuration written");

// Clone GitHub repo if specified
let workDir = home;
const REPO_WORKDIR = join(home, "workspace");
const projectMode = Boolean(PROJECT_WORKDIR) && existsSync(PROJECT_WORKDIR);

// A resumed persistent code session (paused sandbox or restored checkpoint)
// already has the repo with its local branches/commits/uncommitted edits:
// never re-clone over it, only refresh the credentialed remote.
const RESUMING_REPO =
  Boolean(GITHUB_REPO_URL) && existsSync(join(REPO_WORKDIR, ".git"));

if (projectMode) {
  workDir = PROJECT_WORKDIR;
  projects[workDir] = { allowedTools: ["*"], hasTrustDialogAccepted: true };
  writeFileSync(
    join(home, ".claude", "projects.json"),
    JSON.stringify(projects),
  );
  settings.allowedDirectories.push(workDir);
  writeFileSync(settingsPath, JSON.stringify(settings));
  log("info", "Using restored project workspace", {
    workDir,
    project: PROJECT_NAME,
  });
} else if (RESUMING_REPO) {
  workDir = REPO_WORKDIR;
  try {
    const authUrl = GITHUB_TOKEN
      ? GITHUB_REPO_URL.replace(
          "https://github.com",
          `https://x-access-token:${GITHUB_TOKEN}@github.com`,
        )
      : GITHUB_REPO_URL;
    try {
      execFileSync("git", ["remote", "set-url", "origin", authUrl], {
        cwd: workDir,
      });
    } catch {
      execFileSync("git", ["remote", "add", "origin", authUrl], {
        cwd: workDir,
      });
    }
    writeFileSync(join(workDir, "CLAUDE.md"), CODE_AGENT_SYSTEM_PROMPT);
    projects[workDir] = { allowedTools: ["*"], hasTrustDialogAccepted: true };
    writeFileSync(
      join(home, ".claude", "projects.json"),
      JSON.stringify(projects),
    );
    settings.allowedDirectories.push(workDir);
    writeFileSync(settingsPath, JSON.stringify(settings));
    console.log(`[Setup] Resuming existing repo at ${workDir}`);
  } catch (err) {
    console.error(`[Setup] Failed to refresh resumed repo:`, err.message);
  }
} else if (GITHUB_REPO_URL) {
  console.log(`[Setup] Cloning GitHub repo: ${GITHUB_REPO_URL}`);

  const repoMatch = GITHUB_REPO_URL.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) {
    console.error(`[Setup] Invalid GitHub URL: ${GITHUB_REPO_URL}`);
    process.exit(1);
  }
  workDir = REPO_WORKDIR;

  // Build authenticated clone URL
  const authUrl = GITHUB_TOKEN
    ? GITHUB_REPO_URL.replace(
        "https://github.com",
        `https://x-access-token:${GITHUB_TOKEN}@github.com`,
      )
    : GITHUB_REPO_URL;

  try {
    // Clone repo
    execSync(`git clone ${authUrl} ${workDir}`, {
      stdio: "inherit",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    // Configure git for commits
    execSync(`git config user.name "Rose Agent"`, { cwd: workDir });
    execSync(`git config user.email "agent@roselabs.ai"`, { cwd: workDir });

    writeFileSync(join(workDir, "CLAUDE.md"), CODE_AGENT_SYSTEM_PROMPT);

    // Trust the repo directory for Claude Code (both legacy and modern formats)
    projects[workDir] = { allowedTools: ["*"], hasTrustDialogAccepted: true };
    writeFileSync(
      join(home, ".claude", "projects.json"),
      JSON.stringify(projects),
    );
    settings.allowedDirectories.push(workDir);
    writeFileSync(settingsPath, JSON.stringify(settings));

    console.log(`[Setup] Repo cloned to ${workDir}`);
  } catch (err) {
    console.error(`[Setup] Failed to clone repo:`, err.message);
    // Continue without clone - Claude will see the error in goal context
  }
}

// A project's own CLAUDE.md is never overwritten; the code-agent prompt is
// already passed with --append-system-prompt.
if (!GITHUB_REPO_URL && !projectMode && CODE_AGENT_SYSTEM_PROMPT) {
  writeFileSync(join(workDir, "CLAUDE.md"), CODE_AGENT_SYSTEM_PROMPT);
}

// Persistent code sessions work on their own branch (code-agent-persistent-
// sessions.md §1b). A resumed worktree is already on it; otherwise resume the
// pushed branch, else cut it from CODE_AGENT_BASE_BRANCH (the parent agent's
// branch for sub-agents) or, when that is empty, the repo's default branch.
// A base that is not on the remote is reported, never silently replaced.
function gitRun(args, cwd) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: String(stdout).trim() };
  } catch (err) {
    return { ok: false, out: String(err?.stderr || err?.message || "").trim() };
  }
}

function prepareCodeSessionBranch(repoDir) {
  const branch = (process.env.CODE_AGENT_BRANCH || "").trim();
  if (!branch || !existsSync(join(repoDir, ".git"))) return null;
  const base = (process.env.CODE_AGENT_BASE_BRANCH || "").trim();
  if (!gitRun(["check-ref-format", "--branch", branch], repoDir).ok) {
    log("warn", "Ignoring invalid code-session branch name", { branch });
    return null;
  }
  const result = { branch, base: base || null, source: null, error: null };
  if (
    gitRun(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], repoDir).ok
  ) {
    const current = gitRun(["symbolic-ref", "-q", "--short", "HEAD"], repoDir);
    if (current.out !== branch) {
      const switched = gitRun(["checkout", branch], repoDir);
      if (!switched.ok) result.error = switched.out.slice(0, 300);
    }
    result.source = "local";
  } else if (
    gitRun(
      [
        "fetch",
        "-q",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      repoDir,
    ).ok
  ) {
    const created = gitRun(
      ["checkout", "-B", branch, `origin/${branch}`],
      repoDir,
    );
    if (!created.ok) result.error = created.out.slice(0, 300);
    result.source = "remote";
  } else {
    let start = null;
    if (base) {
      const fetched = gitRun(
        [
          "fetch",
          "-q",
          "origin",
          `+refs/heads/${base}:refs/remotes/origin/${base}`,
        ],
        repoDir,
      );
      if (fetched.ok) {
        start = `origin/${base}`;
        result.source = "base";
      } else {
        result.error = `base branch ${base} is not on the remote`;
      }
    } else {
      gitRun(["remote", "set-head", "origin", "-a"], repoDir);
      const defaultRef = gitRun(
        ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
        repoDir,
      );
      start = defaultRef.ok && defaultRef.out ? defaultRef.out : "HEAD";
      result.source = "default";
    }
    if (start) {
      const created = gitRun(["checkout", "-B", branch, start], repoDir);
      if (!created.ok) result.error = created.out.slice(0, 300);
    }
  }
  result.current =
    gitRun(["symbolic-ref", "-q", "--short", "HEAD"], repoDir).out || null;
  result.head =
    gitRun(["rev-parse", "-q", "--verify", "HEAD"], repoDir).out || null;
  log(result.error ? "warn" : "info", "Code session branch prepared", result);
  try {
    mkdirSync(join(home, ".rose"), { recursive: true });
    writeFileSync(
      join(home, ".rose", "code-session-branch.json"),
      JSON.stringify(result),
    );
  } catch {
    // diagnostics only
  }
  return result;
}

// A restored project workspace gets the same branch model as a cloned repo.
const codeSessionBranch =
  (GITHUB_REPO_URL && workDir === REPO_WORKDIR) || projectMode
    ? prepareCodeSessionBranch(workDir)
    : null;
if (codeSessionBranch) {
  appendEvent({
    type: "code_session_branch",
    branch: codeSessionBranch.current || codeSessionBranch.branch,
    base_branch: codeSessionBranch.base,
    merge_target: (process.env.CODE_AGENT_MERGE_TARGET || "").trim() || null,
    source: codeSessionBranch.source,
    head: codeSessionBranch.head,
    error: codeSessionBranch.error,
  });
}

function promptVersion() {
  return (
    CODE_AGENT_SYSTEM_PROMPT.match(
      /Rose Labs code-agent instructions \(([^)]+)\)/,
    )?.[1] || null
  );
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) => part && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function pathsFromToolInput(input) {
  if (!input || typeof input !== "object") return [];
  return [input.file_path, input.path, input.notebook_path].filter(
    (value) =>
      typeof value === "string" &&
      (value.startsWith(`${home}/`) || value.startsWith("/home/user/")),
  );
}

function detailFromToolInput(input, paths) {
  if (input && typeof input === "object") {
    for (const key of [
      "command",
      "file_path",
      "path",
      "notebook_path",
      "pattern",
      "query",
      "url",
      "description",
    ]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().replace(/\s+/g, " ").slice(0, 240);
      }
    }
  }
  if (Array.isArray(paths) && paths.length) {
    return paths.slice(0, 4).join(", ");
  }
  return "";
}

// `--include-partial-messages` streams the model's output token by token. The
// deltas are broadcast live (first-token latency for direct chat and the
// Transcript tab) but never buffered: the complete `assistant` message that
// follows is the durable record, and replaying every delta on reconnect would
// multiply the history size.
let streamMessageId = null;
const streamBlocks = new Map();
function emitStreamDelta(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "message_start") {
    startNativeTurn();
    streamMessageId = event.message?.id || randomUUID();
    streamBlocks.clear();
    emitNativeUsage(event.message?.usage);
    broadcast("code_agent_delta", {
      version: 1,
      provider: "claude",
      kind: "message_start",
      turn_id: activeTurn?.id,
    });
    return;
  }
  if (event.type === "message_delta") {
    emitNativeUsage(event.usage);
    return;
  }
  const key = `${streamMessageId || activeTurn?.id}:${event.index ?? 0}`;
  if (event.type === "content_block_start") {
    const block = event.content_block || {};
    broadcast("code_agent_delta", {
      version: 1,
      provider: "claude",
      kind: "block_start",
      index: event.index,
      block_type: block.type,
      turn_id: activeTurn?.id,
    });
    streamBlocks.set(key, {
      type: block.type,
      completed: false,
      text: block.text || block.thinking || "",
    });
    if (block.type === "tool_use")
      appendEvent({
        type: "tool_use",
        tool: block.name,
        tool_use_id: block.id,
        input: block.input || {},
        partial: true,
      });
    return;
  }
  if (event.type !== "content_block_delta") return;
  const delta = event.delta || {};
  const type =
    delta.type === "text_delta"
      ? "agent_message"
      : delta.type === "thinking_delta"
        ? "thinking"
        : null;
  if (!type) return;
  const text = delta.text ?? delta.thinking;
  if (typeof text !== "string") return;
  const block = streamBlocks.get(key) || { text: "" };
  block.text += text;
  streamBlocks.set(key, block);
  // Accumulated upserts are durable and replayable. A reconnect receives the
  // same item id and latest text; the final assistant block replaces this row.
  appendEvent({
    type,
    item_id: key,
    text: block.text,
    delta: text,
    partial: true,
  });
  broadcast("code_agent_delta", {
    version: 1,
    provider: "claude",
    kind: type === "thinking" ? "thinking" : "text",
    text,
    index: event.index,
    item_id: key,
    turn_id: activeTurn?.id,
    seq: eventBuffer.length - 1,
  });
}

// Claude emits each finalized block as a separate assistant envelope. Those
// envelopes share one message id, so content[0] is not its native block index.
function completedBlockId(messageId, part, fallbackIndex) {
  for (const [key, block] of streamBlocks) {
    if (
      key.startsWith(`${messageId}:`) &&
      block.type === part.type &&
      !block.completed
    ) {
      block.completed = true;
      return key;
    }
  }
  return `${messageId}:${part.type}:${fallbackIndex}`;
}

function emitClaudeMessage(message) {
  if (message.type === "system" && message.subtype === "init") {
    if (typeof message.model === "string" && message.model)
      effectiveSettings.model = message.model;
    appendEvent({
      type: "session",
      raw_type: "system.init",
      session_id: message.session_id,
      cwd: message.cwd,
      model: message.model,
      tools: message.tools || [],
      permission_mode: message.permissionMode,
      prompt_version: promptVersion(),
    });
    appendOutput("stdout", `[Claude] Session started in ${message.cwd}\n`);
    return;
  }

  if (message.type === "stream_event") {
    emitStreamDelta(message.event);
    return;
  }

  if (message.type === "assistant") {
    const content = message.message?.content || [];
    const messageId = message.message?.id || streamMessageId || randomUUID();
    for (const [partIndex, part] of content.entries()) {
      if (part?.type === "thinking" || part?.type === "redacted_thinking") {
        // Claude Code may omit the thinking text (empty string); the block
        // still marks where the model thought, for the transcript.
        const thinking = typeof part.thinking === "string" ? part.thinking : "";
        appendEvent({
          type: "thinking",
          item_id: completedBlockId(messageId, part, partIndex),
          raw_type: `assistant.${part.type}`,
          text: thinking,
          redacted: part.type === "redacted_thinking" || !thinking,
        });
      }
    }
    for (const [partIndex, part] of content.entries()) {
      if (part?.type === "text" && typeof part.text === "string" && part.text) {
        appendEvent({
          type: "agent_message",
          raw_type: "assistant",
          item_id: completedBlockId(messageId, part, partIndex),
          text: part.text,
          partial: false,
          usage: message.message?.usage || null,
        });
        appendOutput("stdout", `[Claude] ${part.text}\n`);
      }
    }
    for (const part of message.message?.content || []) {
      if (part?.type === "tool_use") {
        const paths = pathsFromToolInput(part.input);
        appendEvent({
          type: "tool_use",
          raw_type: "assistant.tool_use",
          tool: part.name,
          tool_use_id: part.id,
          input: part.input || {},
          paths,
        });
        const detail = detailFromToolInput(part.input || {}, paths);
        appendOutput(
          "stdout",
          `[Claude tool] ${part.name}${detail ? ` · ${detail}` : ""}\n`,
        );
      }
    }
    return;
  }

  if (message.type === "user" && message.tool_use_result !== undefined) {
    const results = (
      Array.isArray(message.message?.content) ? message.message.content : []
    ).filter((part) => part?.type === "tool_result");
    const result = results.length === 1 ? results[0] : null;
    appendEvent({
      type: "tool_result",
      raw_type: "user.tool_result",
      tool_use_id:
        typeof result?.tool_use_id === "string" ? result.tool_use_id : null,
      is_error: result ? result.is_error === true : null,
      // Keep each original block; shared metadata cannot be assigned by position.
      ...(results.length > 1 ? { tool_results: results } : {}),
      tool_use_result: message.tool_use_result,
    });
    return;
  }

  if (message.type === "result") {
    emitNativeUsage(message.usage, true);
    const isSuccess = message.subtype === "success";
    appendEvent({
      type: "result",
      raw_type: `result.${message.subtype}`,
      status: isSuccess ? "completed" : "failed",
      text: isSuccess ? message.result : (message.errors || []).join("\n"),
      usage: message.usage || null,
      model_usage: message.modelUsage || null,
      structured_output: message.structured_output,
      // Turns still owed a result after this one (0 = the CLI is caught up).
      pending_turns: pendingTurns,
    });
    if (isSuccess && message.result) {
      appendOutput("stdout", `[Claude result] ${message.result}\n`);
    } else if (!isSuccess) {
      appendOutput(
        "stderr",
        `[Claude result] ${(message.errors || []).join("\n")}\n`,
      );
    }
    endNativeTurn(
      isSuccess
        ? "completed"
        : message.subtype === "error_during_execution" &&
            message.errors?.some((e) => /interrupt/i.test(e))
          ? "interrupted"
          : "failed",
    );
    return;
  }

  appendEvent({
    type: "cli_message",
    raw_type: message.type,
    cli_message: message,
  });
}

/**
 * Persistent code sessions pass the previous CLI session id. Claude Code looks
 * the transcript up under ~/.claude/projects/<cwd slug>/<id>.jsonl, so a
 * transcript restored under another cwd slug is copied into place. A missing
 * transcript starts a fresh conversation instead of failing the CLI.
 */
function resolveResumeSessionId() {
  const id = (process.env.CLAUDE_CODE_RESUME_SESSION_ID || "").trim();
  if (!id) return null;
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    log("warn", "Ignoring malformed resume session id");
    return null;
  }
  const projectsDir = join(home, ".claude", "projects");
  const expectedDir = join(projectsDir, workDir.replace(/[^A-Za-z0-9]/g, "-"));
  const expected = join(expectedDir, `${id}.jsonl`);
  if (existsSync(expected)) return id;
  let found = null;
  try {
    for (const entry of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, entry, `${id}.jsonl`);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  } catch {
    found = null;
  }
  if (!found) {
    log("warn", "Resume transcript not found; starting a new conversation", {
      sessionId: id,
    });
    return null;
  }
  mkdirSync(expectedDir, { recursive: true });
  copyFileSync(found, expected);
  return id;
}

// ---------------------------------------------------------------------------
// Direct chat: turns delivered to the running CLI
// ---------------------------------------------------------------------------
//
//   backend route / agents helper ──user_turn{id,token,text,sender}──► here
//       │                                   │ dedupe by id (delivered once)
//       │                                   ▼
//       │                     CLI stdin (stream-json user message)
//       ◄──user_turn_ack{id,status,reason?}─│ events broadcast to every client
//                                           ▼ (FE live terminal + activity)
//
// The CLI reads stream-json input and keeps running while stdin is open. An
// autonomous run ends stdin on its first `result`, exactly like the old
// one-shot prompt. A turn written while a turn runs is merged into that
// turn by the CLI (one `result` covers both; measured with Claude Code
// 2.1.284), and every `result` reports the CLI's own `queued_turn_count`,
// so pending turns follow that count, not one result per written turn.
//
// The first *user* turn puts the session on a direct hold: stdin stays open
// between turns until the user hands back (or the hold idles out), so the
// user keeps talking to the same CLI conversation. While the user holds the
// session, `sender: "agent"` turns (Rose agents relaying instructions or
// agent-graph messages) are rejected with `relay_paused` so nothing
// competes with the user; the caller retries after the hand back. Agent
// turns never take the hold: they are ordinary queued turns, answered
// before stdin closes.
const TURN_TOKEN = process.env.CODE_SESSION_TURN_TOKEN || "";
const DIRECT_HOLD_IDLE_MS = (() => {
  const raw = Number.parseInt(
    process.env.CODE_SESSION_DIRECT_HOLD_IDLE_MS || "",
    10,
  );
  return Number.isInteger(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();
const MAX_TURN_TEXT_CHARS = 100_000;
const MAX_TURN_ID_CHARS = 128;

let cliChild = null;
let cliStdinOpen = false;
// Turns written to stdin (the task prompt + delivered user turns) that have
// not produced their `result` yet.
let pendingTurns = 0;
let directHold = false;
let directHoldTimer = null;
const deliveredTurnIds = new Map();
const pendingDeliveries = new Map();
const controlRequests = new Map();
let controlSerial = Promise.resolve();
let effectiveSettings = {
  model: CLAUDE_CODE_MODEL,
  ...(process.env.CLAUDE_CODE_EFFORT
    ? { effort: process.env.CLAUDE_CODE_EFFORT }
    : {}),
  speed: CLAUDE_CODE_FAST_MODE ? "fast" : "standard",
};
let modelCatalog = null;
let nativeInitialization = null;

function startNativeTurn(id = randomUUID()) {
  if (activeTurn) return activeTurn;
  activeTurn = { id, startedAt: new Date().toISOString(), usage: new Map() };
  appendEvent({
    type: "turn_started",
    turn_id: id,
    turn_started_at: activeTurn.startedAt,
  });
  return activeTurn;
}
function emitNativeUsage(usage, final = false) {
  if (!activeTurn || !usage || typeof usage !== "object") return;
  const fields = {};
  const mapping = {
    output_tokens: "output_tokens",
    input_tokens: "input_tokens",
    cached_input_tokens: "cache_read_input_tokens",
  };
  const key = streamMessageId || activeTurn.id;
  const previous = activeTurn.usage.get(key) || {};
  for (const [target, source] of Object.entries(mapping)) {
    const value = usage[source];
    if (Number.isFinite(value) && value >= 0) previous[target] = value;
  }
  activeTurn.usage.set(key, previous);
  for (const name of Object.keys(mapping)) {
    const values = [...activeTurn.usage.values()]
      .map((item) => item[name])
      .filter((value) => Number.isFinite(value));
    if (values.length)
      fields[name] =
        final && Number.isFinite(usage[mapping[name]])
          ? usage[mapping[name]]
          : values.reduce((sum, value) => sum + value, 0);
  }
  if (Object.keys(fields).length)
    appendEvent({ type: "usage", usage_scope: "turn", ...fields });
}

function endNativeTurn(outcome) {
  if (!activeTurn) return;
  appendEvent({
    type: "turn_ended",
    turn_ended_at: new Date().toISOString(),
    turn_outcome: outcome,
  });
  activeTurn = null;
}
// The CLI answers initialize only after its own startup, which exceeded 5s on
// cold E2B sandboxes. That request waits for the answer or the CLI's exit
// (the close handler rejects it); runtime settings changes stay bounded.
function cliControl(request, confirmWithinMs = 5000) {
  if (!cliChild || !cliStdinOpen)
    return Promise.reject(new Error("session_ended"));
  const request_id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer =
      confirmWithinMs === null
        ? null
        : setTimeout(() => {
            controlRequests.delete(request_id);
            reject(new Error("settings_unconfirmed"));
          }, confirmWithinMs);
    controlRequests.set(request_id, { resolve, reject, timer });
    cliChild.stdin.write(
      JSON.stringify({ type: "control_request", request_id, request }) + "\n",
    );
  });
}
function settleControl(message) {
  if (message.type !== "control_response") return false;
  const response = message.response || {};
  const pending = controlRequests.get(response.request_id);
  if (pending) {
    controlRequests.delete(response.request_id);
    clearTimeout(pending.timer);
    if (response.subtype === "success")
      pending.resolve(response.response || {});
    else pending.reject(new Error("settings_rejected"));
  }
  return true;
}
function nativeModelOption(models, model) {
  return (
    models.find((m) => m.value === model) ||
    models.find(
      (m) =>
        ["sonnet", "opus", "haiku"].includes(m.value) &&
        model.startsWith(`claude-${m.value}-`),
    )
  );
}
function nativeDefaultSettings(models, model, env) {
  const option = nativeModelOption(models, model);
  const effort =
    env.CLAUDE_CODE_EFFORT ||
    (option?.supportedEffortLevels?.includes("medium") ? "medium" : null);
  // The native speed selection is independent of the opt-in cache proxy.
  const speed =
    env.CLAUDE_CODE_SPEED ||
    (env.CLAUDE_CODE_FAST_MODE
      ? env.CLAUDE_CODE_FAST_MODE === "1"
        ? "fast"
        : "standard"
      : option?.supportsFastMode
        ? "fast"
        : "standard");
  if (
    !["standard", "fast"].includes(speed) ||
    (speed === "fast" && !option?.supportsFastMode) ||
    (effort && !option?.supportedEffortLevels?.includes(effort))
  )
    throw new Error("unsupported_settings");
  return { ...(effort ? { effort } : {}), speed };
}
async function initializeNativeSettings() {
  const response = await cliControl({ subtype: "initialize" }, null);
  modelCatalog = Array.isArray(response.models) ? response.models : [];
  const defaults = nativeDefaultSettings(
    modelCatalog,
    effectiveSettings.model,
    process.env,
  );
  await cliControl({
    subtype: "apply_flag_settings",
    settings: {
      ...(defaults.effort ? { effortLevel: defaults.effort } : {}),
      fastMode: defaults.speed === "fast",
    },
  });
  Object.assign(effectiveSettings, defaults);
}
async function sessionCapabilities() {
  if (nativeInitialization) await nativeInitialization;
  const models = (modelCatalog || [])
    .filter((m) => typeof m.value === "string")
    .map((m) => ({
      model: m.value,
      label: m.displayName || m.value,
      efforts: m.supportedEffortLevels || [],
      speeds: m.supportsFastMode ? ["standard", "fast"] : ["standard"],
    }));
  const current = nativeModelOption(
    modelCatalog || [],
    effectiveSettings.model,
  );
  if (current && !models.some((m) => m.model === effectiveSettings.model))
    models.push({
      model: effectiveSettings.model,
      label: current.displayName || effectiveSettings.model,
      efforts: current.supportedEffortLevels || [],
      speeds: current.supportsFastMode ? ["standard", "fast"] : ["standard"],
    });
  if (!models.length)
    models.push({
      model: effectiveSettings.model,
      label: effectiveSettings.model,
      efforts: effectiveSettings.effort ? [effectiveSettings.effort] : [],
      speeds: [effectiveSettings.speed],
    });
  return {
    code_provider: "claude",
    effective_settings: { ...effectiveSettings },
    models,
  };
}
async function applyTurnSettings(settings = {}) {
  const changed = Object.entries(settings).filter(
    ([key, value]) => value != null && value !== effectiveSettings[key],
  );
  if (!changed.length) return;
  const caps = await sessionCapabilities();
  const model = settings.model || effectiveSettings.model;
  const option = caps.models.find((m) => m.model === model);
  if (
    !option ||
    (settings.effort && !option.efforts.includes(settings.effort)) ||
    (settings.speed && !option.speeds.includes(settings.speed))
  )
    throw new Error("unsupported_settings");
  if (settings.model && settings.model !== effectiveSettings.model) {
    await cliControl({ subtype: "set_model", model });
    effectiveSettings.model = model;
  }
  const flags = {};
  if (settings.effort != null) flags.effortLevel = settings.effort;
  if (settings.speed != null) flags.fastMode = settings.speed === "fast";
  if (Object.keys(flags).length) {
    await cliControl({ subtype: "apply_flag_settings", settings: flags });
    if (settings.effort != null) effectiveSettings.effort = settings.effort;
    if (settings.speed != null) effectiveSettings.speed = settings.speed;
  }
}
function stageTurnAttachments(id, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  if (attachments.length > 20 || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new Error("invalid_attachments");
  const directory = join(home, "attachments", "direct", id);
  mkdirSync(directory, { recursive: true });
  let bytes = 0;
  return attachments.map((attachment, index) => {
    if (
      typeof attachment.base64_data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        attachment.base64_data,
      )
    )
      throw new Error("invalid_attachments");
    const data = Buffer.from(attachment.base64_data, "base64");
    bytes += data.length;
    if (data.length > 20 * 1024 * 1024 || bytes > 100 * 1024 * 1024)
      throw new Error("attachments_too_large");
    const name = String(attachment.name || "attachment")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 180);
    const path = join(directory, `${index}-${name}`);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, data, { mode: 0o600 });
    renameSync(temporaryPath, path);
    return path;
  });
}

function userMessageLine(text) {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

function tokenMatches(candidate) {
  if (!TURN_TOKEN || typeof candidate !== "string") return false;
  const expected = Buffer.from(TURN_TOKEN, "utf8");
  const actual = Buffer.from(candidate, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function clearDirectHoldTimer() {
  if (directHoldTimer) {
    clearTimeout(directHoldTimer);
    directHoldTimer = null;
  }
}

function endCliStdin(reason) {
  if (!cliStdinOpen || !cliChild) return;
  cliStdinOpen = false;
  clearDirectHoldTimer();
  log("info", "Closing CLI stdin", { reason });
  cliChild.stdin.end();
}

function releaseDirectHold(reason) {
  if (!directHold) return;
  directHold = false;
  clearDirectHoldTimer();
  appendEvent({ type: "direct_chat", status: "released", reason });
  if (pendingTurns === 0) endCliStdin(`direct hold released: ${reason}`);
}

function onCliTurnResult(message) {
  // A turn written mid-turn is merged into the running turn, so one `result`
  // can answer several writes; the CLI says how many are still queued.
  // (CLIs without the field: one result per written turn.)
  const queued = message?.queued_turn_count;
  pendingTurns =
    Number.isInteger(queued) && queued >= 0
      ? queued
      : Math.max(0, pendingTurns - 1);
  if (pendingTurns > 0) return;
  if (!directHold) {
    endCliStdin("autonomous turn finished");
    return;
  }
  clearDirectHoldTimer();
  directHoldTimer = setTimeout(
    () => releaseDirectHold("idle"),
    DIRECT_HOLD_IDLE_MS,
  );
}

function turnAck(id, status, reason) {
  return { type: "user_turn_ack", id, status, ...(reason ? { reason } : {}) };
}

async function handleUserTurn(msg) {
  const id = typeof msg.id === "string" ? msg.id : "";
  if (!tokenMatches(msg.token)) return turnAck(id, "rejected", "unauthorized");
  if (deliveredTurnIds.has(id))
    return { ...deliveredTurnIds.get(id), status: "duplicate" };
  if (pendingDeliveries.has(id))
    return pendingDeliveries
      .get(id)
      .then((ack) =>
        ack.status === "delivered" ? { ...ack, status: "duplicate" } : ack,
      );
  const promise = controlSerial.then(() => deliverNativeTurn(msg));
  controlSerial = promise.catch(() => {});
  pendingDeliveries.set(id, promise);
  try {
    return await promise;
  } finally {
    pendingDeliveries.delete(id);
  }
}
async function deliverNativeTurn(msg) {
  const id = typeof msg.id === "string" ? msg.id : "";
  if (!tokenMatches(msg.token)) return turnAck(id, "rejected", "unauthorized");
  if (!id || id.length > MAX_TURN_ID_CHARS) {
    return turnAck(id, "rejected", "invalid_id");
  }
  if (deliveredTurnIds.has(id))
    return { ...deliveredTurnIds.get(id), status: "duplicate" };
  const text = typeof msg.text === "string" ? msg.text.replace(/\0/g, "") : "";
  if (
    (!text.trim() && !msg.attachments?.length) ||
    text.length > MAX_TURN_TEXT_CHARS
  ) {
    return turnAck(id, "rejected", "invalid_text");
  }
  if (exitAnnounced || !cliStdinOpen || !cliChild) {
    return turnAck(id, "rejected", "session_ended");
  }
  const sender = msg.sender === "agent" ? "agent" : "user";
  if (sender === "agent" && directHold) {
    return turnAck(id, "rejected", "relay_paused");
  }
  try {
    if (nativeInitialization) await nativeInitialization;
    await applyTurnSettings(msg.settings);
  } catch (error) {
    return turnAck(id, "rejected", error.message);
  }
  if (exitAnnounced || !cliStdinOpen)
    return turnAck(id, "rejected", "session_ended");
  let files;
  try {
    files = stageTurnAttachments(id, msg.attachments);
  } catch (error) {
    return turnAck(id, "rejected", error.message);
  }
  const mode = activeTurn ? "steer" : "start";
  const turn = startNativeTurn();
  pendingTurns += 1;
  try {
    await new Promise((resolve, reject) => {
      cliChild.stdin.write(
        userMessageLine(
          text +
            (files.length ? "\n\nAttached files:\n" + files.join("\n") : ""),
        ),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } catch (error) {
    pendingTurns = Math.max(0, pendingTurns - 1);
    if (mode === "start" && activeTurn?.id === turn.id) endNativeTurn("failed");
    return turnAck(id, "rejected", "session_ended");
  }
  if (sender === "user") {
    clearDirectHoldTimer();
    if (!directHold) {
      directHold = true;
      appendEvent({ type: "direct_chat", status: "held", sender });
    }
  }
  appendEvent({
    type: "user_turn",
    turn_id: turn.id,
    client_message_id: id,
    sender,
    text,
    attachments: files,
  });
  appendOutput("stdout", `[${sender === "user" ? "You" : "Agent"}] ${text}\n`);
  log("info", "Delivered user turn", { id, sender, chars: text.length });
  const ack = {
    ...turnAck(id, "delivered"),
    effective_settings: { ...effectiveSettings },
    delivery_mode: mode,
    turn_id: turn.id,
  };
  deliveredTurnIds.set(id, ack);
  return ack;
}

function handleHandBack(msg) {
  if (!tokenMatches(msg.token)) {
    return {
      type: "hand_back_ack",
      status: "rejected",
      reason: "unauthorized",
    };
  }
  const wasHeld = directHold;
  releaseDirectHold("handed_back");
  return { type: "hand_back_ack", status: wasHeld ? "released" : "not_held" };
}

function startupBudgetMs() {
  try {
    const cfg = JSON.parse(readFileSync(PROJECT_STARTUP_CONFIG, "utf8"));
    const timeoutS = Number(cfg.timeoutS);
    return ((Number.isFinite(timeoutS) ? timeoutS : 120) + 30) * 1000;
  } catch {
    return 150 * 1000;
  }
}

/** Run the project's startup script (bounded); resolves its report or null. */
function runProjectStartup() {
  if (!projectMode || !PROJECT_STARTUP || !existsSync(PROJECT_STARTUP)) {
    return Promise.resolve(null);
  }
  appendEvent({
    type: "project_startup",
    status: "running",
    project: PROJECT_NAME,
  });
  appendOutput(
    "stdout",
    `[Project] Running startup script for ${PROJECT_NAME}\n`,
  );
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let guard = null;
    const done = (report) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      appendEvent({
        type: "project_startup",
        project: PROJECT_NAME,
        ...report,
      });
      log("info", "Project startup finished", {
        status: report.status,
        exitCode: report.exitCode,
        durationMs: report.durationMs,
      });
      resolve(report);
    };
    const fallback = (status, detail) => ({
      status,
      exitCode: null,
      durationMs: 0,
      timeoutS: null,
      outputTail: detail,
      logPath: null,
    });
    const child = spawn(
      process.execPath,
      [PROJECT_STARTUP, PROJECT_STARTUP_CONFIG].filter(Boolean),
      {
        cwd: workDir,
        env: { ...process.env, HOME: home },
        // A piped stdin closed at once: the startup script gets EOF, and the
        // stdin structural guard (no "ignore") still holds for every spawn.
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = (stdout + text).slice(-64 * 1024);
      appendOutput("stdout", text);
    });
    child.stderr.on("data", (chunk) =>
      appendOutput("stderr", chunk.toString("utf8")),
    );
    guard = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      done(fallback("timeout", "startup runner did not finish"));
    }, startupBudgetMs());
    child.on("error", (err) => done(fallback("failed", err.message)));
    child.on("exit", () => {
      const line = stdout
        .split("\n")
        .reverse()
        .find((l) => l.startsWith(PROJECT_STARTUP_REPORT_PREFIX));
      try {
        done(JSON.parse(line.slice(PROJECT_STARTUP_REPORT_PREFIX.length)));
      } catch {
        done(fallback("failed", "startup runner produced no report"));
      }
    });
  });
}

/** One factual paragraph for the CLI about the project startup outcome. */
function projectStartupNote(report) {
  if (!report || report.status === "skipped") return "";
  const name = PROJECT_NAME ? ` for project ${PROJECT_NAME}` : "";
  const secs = ((report.durationMs || 0) / 1000).toFixed(1);
  const logRef = report.logPath ? ` Log: ${report.logPath}.` : "";
  if (report.status === "ok") {
    return `Project startup${name} finished OK in ${secs}s.${logRef}\n\n`;
  }
  const tail = String(report.outputTail || "").slice(-1500);
  const what =
    report.status === "timeout"
      ? `TIMED OUT after ${report.timeoutS ?? "?"}s and was stopped; services it starts may not be running.`
      : `FAILED (exit ${report.exitCode ?? "?"}) after ${secs}s.`;
  return `Project startup${name} ${what}${logRef}\nLast output:\n${tail}\n\n`;
}

async function runClaudeCli(startupReport = null) {
  const sanitizedGoal = GOAL.replace(/\0/g, "");
  // Direct-chat stream-json user message; the project startup note leads the task.
  const prompt = userMessageLine(
    `${projectStartupNote(startupReport)}Task:\n${sanitizedGoal}`,
  );

  appendEvent({
    type: "session",
    status: "starting",
    cwd: workDir,
    prompt_version: promptVersion(),
  });
  log("info", "Starting Claude Code CLI", {
    model: CLAUDE_CODE_MODEL,
    workDir,
    goal: sanitizedGoal.slice(0, 100),
  });

  const args = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--model",
    CLAUDE_CODE_MODEL,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite",
    // Code agents cannot ask the user questions. These are the CLI tools whose
    // requiresUserInteraction() asks the user (claude-code-src
    // AskUserQuestionTool.tsx:155, ExitPlanModeV2Tool.ts:185; EnterPlanMode leads
    // to ExitPlanMode). --disallowedTools removes them from the model's tool list
    // (tools.ts filterToolsByDenyRules); --allowedTools only pre-approves.
    "--disallowedTools",
    "AskUserQuestion,EnterPlanMode,ExitPlanMode",
  ];
  if (CLAUDE_CODE_FAST_MODE) {
    args.push("--settings", JSON.stringify({ fastMode: true }));
  }
  if (CODE_AGENT_SYSTEM_PROMPT) {
    args.push("--append-system-prompt", CODE_AGENT_SYSTEM_PROMPT);
  }
  // Rose agent tools (display / send_message_to_user / change_environment_size)
  // as an MCP server. The backend writes ~/.rose/mcp.json at session create.
  const roseMcpConfig = join(home, ".rose", "mcp.json");
  if (existsSync(roseMcpConfig)) {
    args.push("--mcp-config", roseMcpConfig);
    args[args.indexOf("--allowedTools") + 1] += ",mcp__rose";
  }
  const resumeSessionId = resolveResumeSessionId();
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  // The prompt is delivered on stdin, NOT as a positional argument. With
  // `--input-format stream-json` it is one JSON user message; stdin stays open
  // so direct-chat user turns can follow (closed by endCliStdin).
  // Claude Code CLI (>=2.x) ignores a positional prompt when
  // `--output-format stream-json` is set and reads the prompt from stdin
  // instead; passing it positionally makes the CLI exit 1 immediately with
  // "Input must be provided either through stdin or as a prompt argument when
  // using --print". (Default `--input-format text` reads raw text from stdin.)
  const child = spawn("claude", args, {
    cwd: workDir,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      // The CLI's streaming idle watchdog is off unless this is set. Without
      // it a silently dropped /v1/messages stream hangs the session forever
      // (the SDK request timeout only covers the initial fetch, not the
      // body). Enabled, the CLI aborts after CLAUDE_STREAM_IDLE_TIMEOUT_MS
      // (its 90s default) and retries non-streaming. Forced on for every
      // session (E2B overlay and the local fallback both spawn here). See
      // docs/rca/cases/2026-10-02-claude-code-cli-launched-without-stream-idle-watchdog.md
      CLAUDE_ENABLE_STREAM_WATCHDOG: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // If claude exits before consuming the prompt, its stdin emits EPIPE. That
  // error is on the stdin stream (not caught by child.on("error")), so without
  // this listener it would throw an uncaughtException and crash ws-server —
  // exactly the sandbox death this fix set out to prevent. The child's own
  // error/close handlers drive the real shutdown; here we only swallow the pipe
  // error so the write can never take the server down.
  child.stdin.on("error", (err) => {
    log("warn", "claude stdin write error (ignored)", {
      error: err?.message,
      code: err?.code,
    });
  });
  cliChild = child;
  cliStdinOpen = true;
  // Attach output/control handlers before negotiating settings or writing a turn.

  let stdoutRemainder = "";
  let sawResult = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutRemainder += chunk;
    const lines = stdoutRemainder.split(/\r?\n/);
    stdoutRemainder = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (settleControl(message)) continue;
        if (message?.type === "result") {
          sawResult = true;
        }
        // Settle turn accounting first so the result event can say whether
        // more turns are still pending (the monitor's exit grace keys on it).
        if (message?.type === "result") onCliTurnResult(message);
        emitClaudeMessage(message);
      } catch (err) {
        appendOutput("stdout", line + "\n");
        appendEvent({ type: "stdout", text: line });
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    appendOutput("stderr", chunk);
    appendEvent({ type: "stderr", text: chunk });
  });

  child.on("error", (err) => {
    processExited = true;
    appendOutput("stderr", `[Claude] Failed: ${err.message}\n`);
    appendEvent({
      type: "error",
      message: err.message,
      stack: err.stack || null,
    });
    log("error", "Claude Code CLI failed to start", {
      error: err.message,
      stack: err.stack,
    });
    finishRun(1);
  });

  child.on("close", (code) => {
    if (stdoutRemainder.trim()) {
      try {
        const message = JSON.parse(stdoutRemainder);
        if (message?.type === "result") {
          sawResult = true;
        }
        emitClaudeMessage(message);
      } catch {
        appendOutput("stdout", stdoutRemainder + "\n");
        appendEvent({ type: "stdout", text: stdoutRemainder });
      }
    }
    endNativeTurn(code === 0 ? "completed" : "failed");
    for (const pending of controlRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("session_ended"));
    }
    controlRequests.clear();
    processExited = true;
    cliStdinOpen = false;
    if (directHoldTimer) clearTimeout(directHoldTimer);
    const exitCode = Number.isInteger(code) ? code : 1;
    log("info", "Claude Code CLI exited", { exitCode, sawResult });
    finishRun(exitCode);
  });
  // Catalog -> confirmed native flags -> first task turn. No proxy is enabled.
  nativeInitialization = initializeNativeSettings();
  try {
    await nativeInitialization;
    if (!cliStdinOpen) return;
    pendingTurns = 1;
    startNativeTurn();
    child.stdin.write(prompt);
  } catch (error) {
    appendEvent({ type: "error", message: error.message });
    endCliStdin("native settings unconfirmed");
    child.kill("SIGTERM");
  }
}

runProjectStartup().then((report) => runClaudeCli(report));
