#!/usr/bin/env node
/**
 * WebSocket server that runs Claude Code CLI and streams both
 * readable output and normalized JSON events.
 */

import { WebSocketServer } from "ws";
import { createServer } from "http";
import { execFileSync, execSync, spawn } from "child_process";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

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
// Which leased credential this sandbox holds, as a digest (never the token):
// a rejected login names it so the backend can tell an expired or
// since-replaced token from a revoked one (back-end codeLoginRejection.ts).
const CREDENTIAL_FINGERPRINT = CLAUDE_CODE_OAUTH_TOKEN
  ? createHash("sha256")
      .update(CLAUDE_CODE_OAUTH_TOKEN)
      .digest("hex")
      .slice(0, 16)
  : null;
// Provider fast mode is the spawning agent's speed request (CLAUDE_CODE_SPEED);
// CLAUDE_CODE_FAST_MODE=1 is the legacy spelling. Never a cache switch.
const CLAUDE_CODE_FAST_MODE =
  (process.env.CLAUDE_CODE_SPEED ||
    (process.env.CLAUDE_CODE_FAST_MODE === "1" ? "fast" : "")) === "fast";
// The backend sets CLAUDE_CODE_MODEL from the parent's tier; this fallback is the
// flash row of back-end/src/providers/codeAgentModels.ts (codex-code-model.case.ts).
const CLAUDE_CODE_MODEL = process.env.CLAUDE_CODE_MODEL || "claude-opus-5-5";
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

// The port is bound first and answers plain HTTP with the startup state, so a
// probe can tell a server that is cloning from one that serves. A bound socket
// whose event loop is blocked answers nothing, which the backend's old
// `netstat | grep :3000` probe called ready. WebSocket handshakes are refused
// with 503 until the server serves, so no connection handler runs before the
// module's state exists. "Server listening" is logged once it serves.
//
//   starting ─▶ cloning ─▶ starting ─▶ ready      GET / : 503 {state} … 200 {state:"ready"}
const startup = {
  state: "starting",
  phase: "init",
  startedAt: Date.now(),
  cloneMs: null,
  cloneChild: null,
};
const httpServer = createServer((req, res) => {
  const ready = startup.state === "ready";
  res.writeHead(ready ? 200 : 503, {
    "content-type": "application/json",
    ...(ready ? {} : { "retry-after": "2" }),
  });
  res.end(
    JSON.stringify({
      state: startup.state,
      phase: startup.phase,
      elapsed_ms: Date.now() - startup.startedAt,
      clone_ms: startup.cloneMs,
    }),
  );
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  if (startup.state !== "ready") {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
httpServer.listen(PORT);

function markServing() {
  startup.state = "ready";
  startup.phase = "serving";
  const announce = () =>
    log("info", "Server listening", {
      port: httpServer.address().port,
      startup_ms: Date.now() - startup.startedAt,
      clone_ms: startup.cloneMs,
      ...(process.env.ROSE_LOCAL_WS_READINESS_TOKEN
        ? { readinessToken: process.env.ROSE_LOCAL_WS_READINESS_TOKEN }
        : {}),
    });
  if (httpServer.listening) announce();
  else httpServer.once("listening", announce);
}

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

// Replay frames stay far below a client's receive limit (aiohttp: 4 MiB). One
// frame for a long session's whole history exceeded it, and the client then
// reconnected forever without reading the exit queued behind it.
const REPLAY_FRAME_BYTES = 1024 * 1024;
const REPLAY_OUTPUT_CHARS = 256 * 1024;

// The terminal buffer replays as `buffer` (reset) followed by `stdout` (append)
// chunks, which every client already handles.
function sendOutputReplay(ws) {
  for (let start = 0; start < outputBuffer.length;) {
    let end = Math.min(start + REPLAY_OUTPUT_CHARS, outputBuffer.length);
    const last = outputBuffer.charCodeAt(end - 1);
    if (end < outputBuffer.length && last >= 0xd800 && last <= 0xdbff) end--;
    ws.send(
      JSON.stringify({
        type: start === 0 ? "buffer" : "stdout",
        data: outputBuffer.slice(start, end),
      }),
    );
    start = end;
  }
}

// A client that asks for `?replay_chunks=1` gets the event history as bounded
// `code_agent_events` frames: chunk 0 replaces what it holds, later chunks
// append, `last` marks the end. Older clients get the single frame they expect.
function sendEventReplay(ws, events, chunked) {
  if (!chunked) {
    ws.send(JSON.stringify({ type: "code_agent_events", data: events }));
    return;
  }
  let parts = [];
  let bytes = 0;
  let chunk = 0;
  const flush = (last) => {
    ws.send(
      `{"type":"code_agent_events","chunk":${chunk},"last":${last},"data":[${parts.join(",")}]}`,
    );
    chunk++;
    parts = [];
    bytes = 0;
  };
  for (const event of events) {
    const part = JSON.stringify(event);
    const size = Buffer.byteLength(part);
    if (parts.length > 0 && bytes + size > REPLAY_FRAME_BYTES) flush(false);
    parts.push(part);
    bytes += size;
  }
  flush(true);
}

wss.on("connection", (ws, req) => {
  // Send full buffer to new client
  const replay = wantsReplay(req);
  const params = new URL(req?.url || "/", "http://localhost").searchParams;
  if (replay && outputBuffer.length > 0) sendOutputReplay(ws);
  if (replay && eventBuffer.length > 0) {
    const rawCursor = params.get("cursor");
    const cursor =
      rawCursor !== null && /^\d+$/.test(rawCursor) ? Number(rawCursor) : -1;
    sendEventReplay(
      ws,
      eventBuffer.filter((event) => event.seq > cursor),
      params.get("replay_chunks") === "1",
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

// Each partial stream event carries the whole block so far. Once a newer
// snapshot or the final block of the same item arrives, the stored copy keeps
// only its delta, so the replay buffer grows with the output, not its square.
const latestPartialIndex = new Map();
function supersedePartialSnapshot(event, index) {
  // An empty final (e.g. redacted thinking) supersedes nothing: the streamed
  // text is the only copy.
  if (typeof event.item_id !== "string" || typeof event.text !== "string")
    return;
  if (!event.text) return;
  const key = `${event.type}:${event.turn_id ?? ""}:${event.item_id}`;
  const previous = latestPartialIndex.get(key);
  if (previous !== undefined) {
    const compacted = { ...eventBuffer[previous] };
    delete compacted.text;
    eventBuffer[previous] = compacted;
  }
  if (event.partial === true) latestPartialIndex.set(key, index);
  else latestPartialIndex.delete(key);
}

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
  supersedePartialSnapshot(normalized, eventBuffer.length);
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
  dropStartupTurns("session_ended");
  resolveTaskPrompt();
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
  if (startup.state !== "ready") {
    // Signalled while cloning or configuring: the session state below does not
    // exist yet. Stop the clone (its temp dir is removed by the next start).
    startup.cloneChild?.kill("SIGTERM");
    httpServer.close(() => {
      log("info", "Shutdown complete");
      process.exit(exitCode);
    });
    setTimeout(() => process.exit(exitCode), 5000);
    return;
  }
  endNativeTurn("interrupted");
  if (cliChild && !processExited) cliChild.kill("SIGTERM");

  announceExit(exitCode);

  // Close server
  httpServer.close();
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

// A startup phase is one named, timed step of getting the session ready. It
// is logged and kept in the event buffer, so a benchmark can read how long the
// clone took from the sandbox log or the replayed events.
function recordStartupPhase(name, status, startedAt) {
  const durationMs = Date.now() - startedAt;
  log("info", "Startup phase", { name, status, duration_ms: durationMs });
  appendEvent({ type: "startup_phase", name, status, duration_ms: durationMs });
  return durationMs;
}

// `git clone` runs as a child process, not on the event loop, so the server
// keeps answering "cloning" while a large repo downloads. It clones into a
// sibling temp dir and renames it into place: a clone that is interrupted (a
// restart, a pause) never leaves a half-written workspace that the next start
// would take for a resumable repo ("HEAD is not a commit"). A finished clone
// is found by RESUMING_REPO below and never repeated.
const CLONE_TMP_PREFIX = ".workspace-cloning-";
async function cloneRepoAtomically(authUrl, destDir) {
  for (const name of readdirSync(home)) {
    // Left behind by a server that was killed mid-clone.
    if (name.startsWith(CLONE_TMP_PREFIX))
      rmSync(join(home, name), { recursive: true, force: true });
  }
  const tmpDir = join(home, `${CLONE_TMP_PREFIX}${process.pid}`);
  const startedAt = Date.now();
  startup.state = "cloning";
  startup.phase = "clone";
  let status = "completed";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("git", ["clone", authUrl, tmpDir], {
        stdio: "inherit",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      startup.cloneChild = child;
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`git clone exited with ${code ?? signal}`)),
      );
    });
    renameSync(tmpDir, destDir);
  } catch (err) {
    status = "failed";
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  } finally {
    startup.cloneChild = null;
    startup.state = "starting";
    startup.phase = "configure";
    const durationMs = recordStartupPhase("clone", status, startedAt);
    // A failed clone is not a clone time: the failure is in the log and the event.
    startup.cloneMs = status === "completed" ? durationMs : null;
  }
}

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
    console.error(
      `[Setup] Failed to refresh resumed repo:`,
      redactCredentials(err.message),
    );
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
    // Clone repo (off the event loop, atomically: see cloneRepoAtomically)
    await cloneRepoAtomically(authUrl, workDir);

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
    console.error(
      `[Setup] Failed to clone repo:`,
      redactCredentials(err.message),
    );
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
// Credentials never leave the server in text: a URL's userinfo and the token
// itself are masked in every error that reaches a log, an event or the output.
function redactCredentials(text) {
  let out = String(text ?? "").replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@");
  if (GITHUB_TOKEN) out = out.split(GITHUB_TOKEN).join("***");
  return out;
}

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
    return {
      ok: false,
      status: err?.status ?? null,
      out: redactCredentials(String(err?.stderr || err?.message || "").trim()),
    };
  }
}

// A base that cannot be fetched is "not on the remote" only when the remote
// answers that no such branch exists (`git ls-remote --exit-code` exits 2). Any
// other failure (GitHub refusing with a rate limit, an outage, no network) is
// reported with git's own output, so the agent is not told to fix a branch that
// is fine. git exposes no reset time for a refusal.
function baseFetchError(base, repoDir, fetched) {
  const probe = gitRun(
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${base}`],
    repoDir,
  );
  if (probe.status === 2) return `base branch ${base} is not on the remote`;
  return `could not fetch base branch ${base}: ${(fetched.out || probe.out).slice(0, 300)}`;
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
        result.error = baseFetchError(base, repoDir, fetched);
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
      speed: effectiveSettings.speed,
      ...(effectiveSettings.effort ? { effort: effectiveSettings.effort } : {}),
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
    if (typeof message.error === "string" && message.error) {
      // The SDK's structured API-error kind (billing_error = out of credits,
      // authentication_failed, rate_limit, ...): the activity acts on this
      // field, never on the printed banner text (C15).
      appendEvent({
        type: "cli_message",
        raw_type: "assistant.api_error",
        cli_message: { type: "assistant_api_error", error: message.error },
        ...(message.error === "authentication_failed" && CREDENTIAL_FINGERPRINT
          ? { credential: CREDENTIAL_FINGERPRINT }
          : {}),
      });
    }
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
    emitNativeUsage(message.usage, true, message.modelUsage);
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
// Startup window: from the server answering until the CLI is launched (project
// startup runs first and can take minutes). An agent turn that arrives in it is
// acked `queued` and, once the CLI exists, written right after the task prompt in
// arrival order, so a message to a code agent that is still starting is not
// refused (a user's direct turn is told `session_starting` and retries). From the
// launch on, a turn waits for the task prompt (taskPromptReady) before it is
// written. The queue lives and dies with this server: announceExit clears it.
const MAX_STARTUP_TURNS = 20;
const startupTurnQueue = [];
const queuedTurnAcks = new Map();
let resolveTaskPrompt = () => {};
const taskPromptReady = new Promise((resolve) => {
  resolveTaskPrompt = resolve;
});
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
// The model's context window, from the latest result's modelUsage (Claude
// reports it per model); carried on every later usage sample.
let contextWindow = null;
const CONTEXT_INPUT_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];
function emitNativeUsage(usage, final = false, modelUsage = null) {
  if (!activeTurn || !usage || typeof usage !== "object") return;
  const fields = {};
  const windows = Object.values(
    modelUsage && typeof modelUsage === "object" ? modelUsage : {},
  )
    .map((entry) => entry?.contextWindow)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (windows.length) contextWindow = Math.max(...windows);
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
  // One model call's prompt (uncached + cache read + cache write) is the
  // context it used; a result's usage is the turn's total, never a context.
  const context = CONTEXT_INPUT_FIELDS.map((name) => usage[name]).filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  const contextTokens = context.reduce((sum, value) => sum + value, 0);
  if (!final && contextTokens > 0) fields.context_tokens = contextTokens;
  if (contextWindow && Object.keys(fields).length)
    fields.context_window = contextWindow;
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
  // An alias entry ("opus") names the full model it serves in resolvedModel;
  // prefer it over "default", which can resolve to the same model.
  return (
    models.find((m) => m.value === model) ||
    models.find((m) => m.value !== "default" && m.resolvedModel === model) ||
    models.find((m) => m.resolvedModel === model) ||
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
  // The spawning agent's request (CLAUDE_CODE_SPEED, from its Fast Mode
  // button); never fast by default. Fast only where the catalog offers it.
  const requested =
    env.CLAUDE_CODE_SPEED ||
    (env.CLAUDE_CODE_FAST_MODE === "1" ? "fast" : "standard");
  if (
    !["standard", "fast"].includes(requested) ||
    (effort && !option?.supportedEffortLevels?.includes(effort))
  )
    throw new Error("unsupported_settings");
  const speed =
    requested === "fast" && option?.supportsFastMode ? "fast" : "standard";
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

function sameToken(expectedToken, candidate) {
  const expected = Buffer.from(expectedToken, "utf8");
  const actual = Buffer.from(candidate, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function tokenMatches(candidate) {
  if (typeof candidate !== "string") return false;
  return [TURN_TOKEN, ...adoptedTokens].some(
    (token) => token && sameToken(token, candidate),
  );
}

// A resumed spawn attaches to this live CLI instead of restarting it (backend
// attachLiveCodeCli): its goal arrives as an agent turn carrying `attach`.
// `attach.credential` digests the credential env the spawn leased; a CLI
// holding another one cannot adopt it, so the turn is refused before anything
// is written (`credential_changed`) and the backend restarts the CLI. Model,
// effort and speed ride on the turn's `settings`. `attach.config` digests the
// spawn's other start-time env per key; a running CLI keeps its own, and the
// ack names the keys it kept (`ignored_config`). Once the turn reached the
// CLI, the new task's token addresses this session too, and the ack says
// `attached: true` (a ws-server without this support never does).
const adoptedTokens = new Set();
const MAX_ATTACH_KEYS = 32;
const ENV_KEY = /^[A-Z0-9_]{1,64}$/;
function envDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}
function credentialDigest(keys) {
  const names = [...new Set(keys)].sort();
  return envDigest(names.map((key) => [key, process.env[key] ?? null]));
}
function parseAttach(raw) {
  if (raw === undefined || raw === null) return null;
  const keys = raw?.credential?.keys;
  const config = raw.config ?? {};
  if (
    typeof raw.token !== "string" ||
    raw.token.length < 16 ||
    raw.token.length > 256 ||
    typeof raw.credential?.digest !== "string" ||
    !Array.isArray(keys) ||
    keys.length > MAX_ATTACH_KEYS ||
    !keys.every((key) => typeof key === "string" && ENV_KEY.test(key)) ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).length > MAX_ATTACH_KEYS ||
    !Object.entries(config).every(
      ([key, digest]) => ENV_KEY.test(key) && typeof digest === "string",
    )
  )
    return { invalid: true };
  return { token: raw.token, keys, digest: raw.credential.digest, config };
}
function ignoredConfig(config) {
  return Object.entries(config)
    .filter(([key, digest]) => envDigest(process.env[key]) !== digest)
    .map(([key]) => key)
    .sort();
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
  // The user's turn finished the goal: hand the session back so the parent
  // gets the result now (root 0874662a waited out the 10-minute idle hold).
  if (goalHandoffWritten()) {
    releaseDirectHold("goal handoff written");
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
  const attach = parseAttach(msg.attach);
  if (attach?.invalid) return turnAck(id, "rejected", "invalid_attach");
  if (attach && attach.digest !== credentialDigest(attach.keys))
    return turnAck(id, "rejected", "credential_changed");
  const ack = await deliverTurnOnce(id, msg);
  if (attach && (ack.status === "delivered" || ack.status === "duplicate")) {
    adoptedTokens.add(attach.token);
    const ignored = ignoredConfig(attach.config);
    log("info", "Spawn attached to the live CLI", { id, ignored });
    return { ...ack, attached: true, ignored_config: ignored };
  }
  return ack;
}
async function deliverTurnOnce(id, msg) {
  if (deliveredTurnIds.has(id))
    return { ...deliveredTurnIds.get(id), status: "duplicate" };
  if (pendingDeliveries.has(id))
    return pendingDeliveries
      .get(id)
      .then((ack) =>
        ack.status === "delivered" ? { ...ack, status: "duplicate" } : ack,
      );
  if (queuedTurnAcks.has(id)) return { ...queuedTurnAcks.get(id) };
  const invalid = invalidTurn(id, msg);
  if (invalid) return invalid;
  // Decided here, at arrival, not inside the serial chain: a turn that arrives
  // as the prompt is written must queue behind the earlier queued turns.
  if (!cliChild && !exitAnnounced) {
    // Only agent messages wait: a user's direct turn carries settings and
    // attachments that must be confirmed at once, so it is told to retry.
    return msg.sender === "agent"
      ? queueStartupTurn(id, msg)
      : turnAck(id, "rejected", "session_starting");
  }
  return startSerialDelivery(id, msg);
}
function startSerialDelivery(id, msg) {
  const promise = controlSerial.then(() => deliverNativeTurn(msg));
  controlSerial = promise.catch(() => {});
  pendingDeliveries.set(id, promise);
  const done = () => pendingDeliveries.delete(id);
  promise.then(done, done);
  return promise;
}
function queueStartupTurn(id, msg) {
  if (startupTurnQueue.length >= MAX_STARTUP_TURNS) {
    return turnAck(id, "rejected", "startup_queue_full");
  }
  startupTurnQueue.push({ id, msg });
  const ack = {
    ...turnAck(id, "queued"),
    queue_position: startupTurnQueue.length,
  };
  queuedTurnAcks.set(id, ack);
  appendEvent({
    type: "user_turn_queued",
    client_message_id: id,
    sender: msg.sender === "agent" ? "agent" : "user",
    queue_position: ack.queue_position,
  });
  log("info", "Queued user turn until the CLI starts", {
    id,
    queue_position: ack.queue_position,
  });
  return ack;
}
/**
 * The CLI is launched: queued turns enter the delivery chain, ahead of any later
 * arrival. Each waits for the task prompt (deliverNativeTurn), so they follow it.
 */
function releaseStartupTurns() {
  for (const { id, msg } of startupTurnQueue.splice(0)) {
    startSerialDelivery(id, msg).then((ack) => {
      queuedTurnAcks.delete(id);
      if (ack.status !== "delivered" && ack.status !== "duplicate") {
        appendEvent({
          type: "user_turn_undelivered",
          turn_ids: [id],
          reason: ack.reason || "rejected",
        });
      }
    });
  }
}
/** The session ended before the CLI took the queued turns: say which were lost. */
function dropStartupTurns(reason) {
  if (startupTurnQueue.length === 0) return;
  appendEvent({
    type: "user_turn_undelivered",
    turn_ids: startupTurnQueue.map((turn) => turn.id),
    reason,
  });
  startupTurnQueue.length = 0;
  queuedTurnAcks.clear();
}
async function deliverNativeTurn(msg) {
  const id = typeof msg.id === "string" ? msg.id : "";
  const invalid = invalidTurn(id, msg);
  if (invalid) return invalid;
  if (deliveredTurnIds.has(id))
    return { ...deliveredTurnIds.get(id), status: "duplicate" };
  const text = typeof msg.text === "string" ? msg.text.replace(/\0/g, "") : "";
  if (exitAnnounced || !cliStdinOpen || !cliChild) {
    return turnAck(id, "rejected", "session_ended");
  }
  const sender = msg.sender === "agent" ? "agent" : "user";
  if (sender === "agent" && directHold) {
    return turnAck(id, "rejected", "relay_paused");
  }
  const turnText = sender === "agent" ? agentTurnText(text) : text;
  try {
    if (nativeInitialization) await nativeInitialization;
    await taskPromptReady;
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
  // Events before this turn's write belong to earlier turns: a spawn attaching
  // to this live CLI treats them as history (backend attachLiveCodeCli).
  const historyEvents = eventBuffer.length;
  const turn = startNativeTurn();
  pendingTurns += 1;
  try {
    if (turnText !== text) markGoalDelivered();
    await new Promise((resolve, reject) => {
      cliChild.stdin.write(
        userMessageLine(
          turnText +
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
    history_events: historyEvents,
  };
  deliveredTurnIds.set(id, ack);
  return ack;
}

/** The refusal for a turn that can never be delivered, or null when it is well formed. */
function invalidTurn(id, msg) {
  if (!tokenMatches(msg.token)) return turnAck(id, "rejected", "unauthorized");
  if (!id || id.length > MAX_TURN_ID_CHARS) {
    return turnAck(id, "rejected", "invalid_id");
  }
  const text = typeof msg.text === "string" ? msg.text.replace(/\0/g, "") : "";
  if (
    (!text.trim() && !msg.attachments?.length) ||
    text.length > MAX_TURN_TEXT_CHARS
  ) {
    return turnAck(id, "rejected", "invalid_text");
  }
  return null;
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

function projectStartupPaths() {
  try {
    const cfg = JSON.parse(readFileSync(PROJECT_STARTUP_CONFIG, "utf8"));
    return {
      reportPath: typeof cfg.reportPath === "string" ? cfg.reportPath : null,
      logPath: typeof cfg.logPath === "string" ? cfg.logPath : null,
    };
  } catch {
    return { reportPath: null, logPath: null };
  }
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

/**
 * The runner's report: the last stdout line with the report prefix, parsed.
 * Returns { report } or { problem: "missing" | "malformed" }, so a crash that
 * wrote nothing is told apart from a report that cannot be read.
 */
function parseProjectStartupReport(output) {
  const line = output
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(PROJECT_STARTUP_REPORT_PREFIX));
  if (line === undefined) return { problem: "missing" };
  try {
    const report = JSON.parse(line.slice(PROJECT_STARTUP_REPORT_PREFIX.length));
    if (
      report !== null &&
      typeof report === "object" &&
      !Array.isArray(report) &&
      typeof report.status === "string"
    ) {
      return { report };
    }
  } catch {
    // Not JSON: reported as malformed below.
  }
  return { problem: "malformed" };
}

/** Run the project's startup script (bounded); resolves its report or null. */
function runProjectStartup() {
  if (!projectMode || !PROJECT_STARTUP || !existsSync(PROJECT_STARTUP)) {
    return Promise.resolve(null);
  }
  // The report means "this boot's startup finished": a previous boot's report
  // must not tell the agent (or the preview) that dependencies are ready.
  const { reportPath } = projectStartupPaths();
  if (reportPath) rmSync(reportPath, { force: true });
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
    // Backstop only: the runner enforces the script's own timeout (SIGTERM then
    // SIGKILL of the script's process group, which it spawns detached) well
    // inside this budget. Daemons the script starts (Postgres, dev servers)
    // are meant to outlive startup (startupRunner.ts contract), and they are
    // not in the runner's group, so killing more than the runner is wrong.
    guard = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      done(fallback("timeout", "startup runner did not finish"));
    }, startupBudgetMs());
    child.on("error", (err) => done(fallback("failed", err.message)));
    // "close", not "exit": "exit" can fire before the last stdout chunk (the
    // report line) is read. The runner is the only holder of its stdout pipe
    // (the script runs on pipes of its own), so close follows its exit.
    child.on("close", (code, signal) => {
      const ended = signal ? `signal ${signal}` : `exit code ${code}`;
      const parsed = parseProjectStartupReport(stdout);
      if (parsed.report) {
        done(parsed.report);
        return;
      }
      done(
        fallback(
          "failed",
          parsed.problem === "malformed"
            ? `startup runner wrote a malformed report (${ended})`
            : `startup runner produced no report (${ended})`,
        ),
      );
    });
  });
}

/** One factual paragraph for the CLI about the project startup outcome. */
function projectStartupNote(report) {
  if (!report || report.status === "skipped") return "";
  const name = PROJECT_NAME ? ` for project ${PROJECT_NAME}` : "";
  if (report.status === "running") {
    const logRef = report.logPath ? ` Log: ${report.logPath}.` : "";
    const wait = report.reportPath
      ? ` Before builds, tests or dev servers, wait until ${report.reportPath} exists, then read its status.`
      : "";
    return `Project startup${name} is still running in the background (it may be installing dependencies).${logRef}${wait}\n\n`;
  }
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

// Mobbin MCP tools that read or change the token owner's account
// (https://docs.mobbin.com/mcp/features); code agents get catalog search only.
const MOBBIN_ACCOUNT_TOOLS = [
  "list_collections",
  "get_collection_contents",
  "create_collection",
  "save_content",
  "add_comment",
];

/** Whether the backend-written MCP config lists `server`. */
function mcpConfigLists(path, server) {
  try {
    return Boolean(
      JSON.parse(readFileSync(path, "utf8"))?.mcpServers?.[server],
    );
  } catch (err) {
    log("warn", "Unreadable MCP config", { path, error: String(err) });
    return false;
  }
}

// Every code-agent task is Claude Code's own `/goal` (Andy, 2026-11-08): the
// CLI's goal evaluator keeps it working until the condition holds, and the
// task's condition ends with writing the result handoff (and says no questions). /goal caps a condition at
// 4000 characters, so the result schema goes to a file next to the handoff and
// a task too long for the cap goes to a task file the condition names.
const HANDOFF_SCHEMA_PREFIX = "\n\nResult JSON Schema for ";
const DEFAULT_HANDOFF_SCHEMA_PATH = "/home/user/.rose/handoff.schema.json";
const GOAL_CONDITION_MAX_CHARS = 4000;
// The handoff the current goal ends by writing (null: the task had no schema).
let goalHandoffPath = null;
// When the current goal's turn reached the CLI: only a handoff written after
// it counts. Accepting a goal also moves any handoff still on disk aside (a
// close that failed to consume it), keeping it for inspection.
let goalStartedAtMs = Infinity;
let goalPendingDelivery = false;

function retireStaleHandoff(path) {
  if (!existsSync(path)) return;
  try {
    renameSync(path, `${path}.superseded-${Date.now()}`);
  } catch (error) {
    log("warn", "Could not move a stale handoff aside", {
      error: error.message,
    });
  }
}

/** Called as the goal turn is written to the CLI's stdin. */
function markGoalDelivered() {
  if (!goalPendingDelivery) return;
  goalPendingDelivery = false;
  goalStartedAtMs = Date.now();
}

function goalHandoffWritten() {
  if (!goalHandoffPath) return false;
  try {
    return statSync(goalHandoffPath).mtimeMs >= goalStartedAtMs;
  } catch {
    return false;
  }
}

function splitHandoffSchema(text) {
  const at = text.lastIndexOf(HANDOFF_SCHEMA_PREFIX);
  if (at < 0) return null;
  const rest = text.slice(at + HANDOFF_SCHEMA_PREFIX.length);
  const colon = rest.indexOf(":\n");
  if (colon <= 0) return null;
  // The task names sandbox paths; a CLI whose HOME is elsewhere (tests, the
  // local fallback) keeps them under its own HOME.
  const named = rest.slice(0, colon);
  const handoffPath = named.startsWith("/home/user/")
    ? join(homedir(), named.slice("/home/user/".length))
    : named;
  const schema = rest.slice(colon + 2);
  try {
    JSON.parse(schema);
  } catch {
    return null;
  }
  return { task: text.slice(0, at), handoffPath, schema };
}

function writeRoseFile(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return true;
  } catch (error) {
    log("warn", "Could not write a goal file", { path, error: error.message });
    return false;
  }
}

/** The `/goal` turn for a task; writes its schema (and an over-cap task) to files. */
function goalTurnText(rawTask, note = "") {
  const text = String(rawTask).replace(/\0/g, "");
  const split = splitHandoffSchema(text);
  let task = text;
  if (split) {
    const schemaPath = join(dirname(split.handoffPath), "handoff.schema.json");
    if (writeRoseFile(schemaPath, split.schema)) {
      task = split.task.split(DEFAULT_HANDOFF_SCHEMA_PATH).join(schemaPath);
    } else {
      // No schema file: the condition carries the schema inline instead.
      task = `${split.task}${HANDOFF_SCHEMA_PREFIX}${split.handoffPath}:\n${split.schema}`;
    }
    goalHandoffPath = split.handoffPath;
    retireStaleHandoff(goalHandoffPath);
    goalStartedAtMs = Infinity;
    goalPendingDelivery = true;
  }
  // A new spawn's goal reaches a live CLI already headed "Task:" (backend
  // attachLiveCodeCli); the first task is headed here.
  const body = task.startsWith("Task:\n") ? task.slice("Task:\n".length) : task;
  let condition = `${note}Task:\n${body}`;
  if (condition.length > GOAL_CONDITION_MAX_CHARS) {
    const taskPath = join(
      dirname(split ? split.handoffPath : join(homedir(), ".rose", "x")),
      "task.md",
    );
    // Unwritable: send the task as written; /goal then reports the length cap.
    if (writeRoseFile(taskPath, body))
      condition = `${note}Task: read ${taskPath} and do exactly what it says. Its final paragraph is your end condition.`;
  }
  return `/goal ${condition}`;
}

/** A task from the agent graph (a new spawn's goal) starts as a goal; other turns are as written. */
function agentTurnText(text) {
  return splitHandoffSchema(text) ? goalTurnText(text) : text;
}

async function runClaudeCli(startupReport = null) {
  const sanitizedGoal = GOAL.replace(/\0/g, "");
  // Direct-chat stream-json user message; the project startup note leads the task.
  const prompt = userMessageLine(
    goalTurnText(sanitizedGoal, projectStartupNote(startupReport)),
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
    if (mcpConfigLists(roseMcpConfig, "mobbin")) {
      // Mobbin design references (backend-provided token, one Mobbin account):
      // catalog search only, never that account's collections, saves or comments.
      args[args.indexOf("--allowedTools") + 1] += ",mcp__mobbin";
      args[args.indexOf("--disallowedTools") + 1] += MOBBIN_ACCOUNT_TOOLS.map(
        (tool) => `,mcp__mobbin__${tool}`,
      ).join("");
    }
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
  releaseStartupTurns();
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
    markGoalDelivered();
    child.stdin.write(prompt);
    resolveTaskPrompt();
  } catch (error) {
    appendEvent({ type: "error", message: error.message });
    endCliStdin("native settings unconfirmed");
    child.kill("SIGTERM");
  }
}

// A slow project startup (a cold dependency install) does not hold the CLI:
// past the grace window the agent starts, told that startup is still running
// and where its report appears (code-agent-rose-repo waited 469 s for a cold
// npm install, 2026-11-08). A startup that finishes in the window (template
// snapshot, resume) is reported up front as before.
const PROJECT_STARTUP_GRACE_MS = (() => {
  const raw = Number.parseInt(
    process.env.CODE_SESSION_PROJECT_STARTUP_GRACE_MS || "",
    10,
  );
  return Number.isInteger(raw) && raw >= 0 ? raw : 30_000;
})();
function startupReportForCli(startup) {
  let timer = null;
  const running = new Promise((resolve) => {
    timer = setTimeout(() => {
      const { reportPath, logPath } = projectStartupPaths();
      log("info", "Project startup still running; starting the CLI", {
        graceMs: PROJECT_STARTUP_GRACE_MS,
      });
      resolve({ status: "running", reportPath, logPath });
    }, PROJECT_STARTUP_GRACE_MS);
  });
  return Promise.race([startup, running]).finally(() => clearTimeout(timer));
}
const projectStartup = runProjectStartup();
(projectMode && PROJECT_STARTUP
  ? startupReportForCli(projectStartup)
  : projectStartup
).then((report) => runClaudeCli(report));
markServing();
