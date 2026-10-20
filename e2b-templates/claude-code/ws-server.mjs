#!/usr/bin/env node
/**
 * WebSocket server that runs Claude Code CLI and streams both
 * readable output and normalized JSON events.
 */

import { WebSocketServer } from "ws";
import { execSync, spawn } from "child_process";
import { timingSafeEqual } from "crypto";
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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

// After the CLI exits the server keeps serving its final buffer so an agent
// activity that detached for a deploy (or crashed and is retried after its 5m
// heartbeat timeout) can reattach and read the result. Closing the session
// (SIGTERM / sandbox kill) still exits immediately.
const REATTACH_LINGER_MS = 15 * 60 * 1000;

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  log("info", "Server listening", {
    port: PORT,
    ...(process.env.ROSE_LOCAL_WS_READINESS_TOKEN
      ? { readinessToken: process.env.ROSE_LOCAL_WS_READINESS_TOKEN }
      : {}),
  });
});

wss.on("connection", (ws) => {
  // Send full buffer to new client
  if (outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: "buffer", data: outputBuffer }));
  }
  if (eventBuffer.length > 0) {
    ws.send(JSON.stringify({ type: "code_agent_events", data: eventBuffer }));
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
        ws.send(JSON.stringify(handleUserTurn(msg)));
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

function appendEvent(event) {
  const normalized = {
    version: 1,
    provider: "claude",
    timestamp: new Date().toISOString(),
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
let lingerTimer = null;

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
  if (lingerTimer || shuttingDown) return;
  log("info", "Serving final buffer for reattach", {
    exitCode,
    lingerMs: REATTACH_LINGER_MS,
  });
  lingerTimer = setTimeout(() => shutdown(exitCode), REATTACH_LINGER_MS);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (lingerTimer) clearTimeout(lingerTimer);
  log("info", "Starting graceful shutdown", { exitCode });

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

if (GITHUB_REPO_URL) {
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

if (!GITHUB_REPO_URL && CODE_AGENT_SYSTEM_PROMPT) {
  writeFileSync(join(workDir, "CLAUDE.md"), CODE_AGENT_SYSTEM_PROMPT);
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

function emitClaudeMessage(message) {
  if (message.type === "system" && message.subtype === "init") {
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

  if (message.type === "assistant") {
    const text = textFromContent(message.message?.content);
    if (text) {
      appendEvent({
        type: "agent_message",
        raw_type: "assistant",
        text,
        usage: message.message?.usage || null,
      });
      appendOutput("stdout", `[Claude] ${text}\n`);
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
    appendEvent({
      type: "tool_result",
      raw_type: "user.tool_result",
      tool_use_result: message.tool_use_result,
    });
    return;
  }

  if (message.type === "result") {
    const isSuccess = message.subtype === "success";
    appendEvent({
      type: "result",
      raw_type: `result.${message.subtype}`,
      status: isSuccess ? "completed" : "failed",
      text: isSuccess ? message.result : (message.errors || []).join("\n"),
      usage: message.usage || null,
      model_usage: message.modelUsage || null,
      structured_output: message.structured_output,
    });
    if (isSuccess && message.result) {
      appendOutput("stdout", `[Claude result] ${message.result}\n`);
    } else if (!isSuccess) {
      appendOutput(
        "stderr",
        `[Claude result] ${(message.errors || []).join("\n")}\n`,
      );
    }
    return;
  }

  appendEvent({
    type: "cli_message",
    raw_type: message.type,
    cli_message: message,
  });
}

// ---------------------------------------------------------------------------
// Direct chat: user turns delivered to the running CLI
// ---------------------------------------------------------------------------
//
//   backend route / agents helper ──user_turn{id,token,text}──► this server
//       │                                   │ dedupe by id (delivered once)
//       │                                   ▼
//       │                     CLI stdin (stream-json user message)
//       ◄──user_turn_ack{id,status}──       │ events broadcast to every client
//                                           ▼ (FE live terminal + activity)
//
// The CLI reads stream-json input and keeps running while stdin is open. An
// autonomous run ends stdin on its first `result`, exactly like the old
// one-shot prompt. The first user turn puts the session on a "direct hold": stdin stays
// open between turns until the user hands back (or the hold idles out), so
// the user can keep talking to the same CLI conversation.
//
// Agent-graph messages (sender "agent", e.g. the root answering a code
// agent's question) are ordinary queued turns: they never take the direct
// hold, and stdin stays open until every written turn has its `result`, so a
// message that arrives mid-run is answered before the CLI exits.
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
const deliveredTurnIds = new Set();

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

function endCliStdin(reason) {
  if (!cliStdinOpen || !cliChild) return;
  cliStdinOpen = false;
  if (directHoldTimer) {
    clearTimeout(directHoldTimer);
    directHoldTimer = null;
  }
  log("info", "Closing CLI stdin", { reason });
  cliChild.stdin.end();
}

function releaseDirectHold(reason) {
  if (!directHold) return;
  directHold = false;
  appendEvent({ type: "direct_chat", status: "released", reason });
  if (pendingTurns === 0) endCliStdin(`direct hold released: ${reason}`);
}

function onCliTurnResult() {
  pendingTurns = Math.max(0, pendingTurns - 1);
  if (pendingTurns > 0) return;
  if (!directHold) {
    endCliStdin("autonomous turn finished");
    return;
  }
  if (directHoldTimer) clearTimeout(directHoldTimer);
  directHoldTimer = setTimeout(
    () => releaseDirectHold("idle"),
    DIRECT_HOLD_IDLE_MS,
  );
}

function turnAck(id, status, reason) {
  return { type: "user_turn_ack", id, status, ...(reason ? { reason } : {}) };
}

function handleUserTurn(msg) {
  const id = typeof msg.id === "string" ? msg.id : "";
  if (!tokenMatches(msg.token)) return turnAck(id, "rejected", "unauthorized");
  if (!id || id.length > MAX_TURN_ID_CHARS) {
    return turnAck(id, "rejected", "invalid_id");
  }
  if (deliveredTurnIds.has(id)) return turnAck(id, "duplicate");
  const text = typeof msg.text === "string" ? msg.text.replace(/\0/g, "") : "";
  if (!text.trim() || text.length > MAX_TURN_TEXT_CHARS) {
    return turnAck(id, "rejected", "invalid_text");
  }
  if (exitAnnounced || !cliStdinOpen || !cliChild) {
    return turnAck(id, "rejected", "session_ended");
  }
  const sender = msg.sender === "agent" ? "agent" : "user";
  deliveredTurnIds.add(id);
  if (directHoldTimer) {
    clearTimeout(directHoldTimer);
    directHoldTimer = null;
  }
  if (!directHold && sender === "user") {
    directHold = true;
    appendEvent({ type: "direct_chat", status: "held", sender });
  }
  appendEvent({ type: "user_turn", turn_id: id, sender, text });
  appendOutput("stdout", `[${sender === "user" ? "You" : "Agent"}] ${text}\n`);
  pendingTurns += 1;
  cliChild.stdin.write(userMessageLine(text));
  log("info", "Delivered user turn", { id, sender, chars: text.length });
  return turnAck(id, "delivered");
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

async function runClaudeCli() {
  const sanitizedGoal = GOAL.replace(/\0/g, "");
  const prompt = userMessageLine(`Task:\n${sanitizedGoal}`);

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
    "--model",
    CLAUDE_CODE_MODEL,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite",
  ];
  if (CLAUDE_CODE_FAST_MODE) {
    args.push("--settings", JSON.stringify({ fastMode: true }));
  }
  if (CODE_AGENT_SYSTEM_PROMPT) {
    args.push("--append-system-prompt", CODE_AGENT_SYSTEM_PROMPT);
  }
  // Rose agent tools (display / send_message_to_user / request_user_approval)
  // as an MCP server. The backend writes ~/.rose/mcp.json at session create;
  // MCP calls have no Bash 2-minute limit, so blocking approvals can wait.
  const roseMcpConfig = join(home, ".rose", "mcp.json");
  if (existsSync(roseMcpConfig)) {
    args.push("--mcp-config", roseMcpConfig);
    args[args.indexOf("--allowedTools") + 1] += ",mcp__rose";
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
  pendingTurns = 1;
  child.stdin.write(prompt);

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
        if (message?.type === "result") {
          sawResult = true;
        }
        emitClaudeMessage(message);
        if (message?.type === "result") onCliTurnResult();
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
    processExited = true;
    cliStdinOpen = false;
    if (directHoldTimer) clearTimeout(directHoldTimer);
    const exitCode = Number.isInteger(code) ? code : 1;
    log("info", "Claude Code CLI exited", { exitCode, sawResult });
    finishRun(exitCode);
  });
}

runClaudeCli();
