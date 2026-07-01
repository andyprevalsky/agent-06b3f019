#!/usr/bin/env node
/**
 * WebSocket server that runs Claude Code CLI and streams both
 * readable output and normalized JSON events.
 */

import { WebSocketServer } from "ws";
import { execSync, spawn } from "child_process";
import { appendFileSync, writeFileSync, mkdirSync } from "fs";
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

const PORT = 3000;
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

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT });

log("info", "Server listening", { port: PORT });

wss.on("connection", (ws) => {
  log("info", "Client connected", { total: clients.size + 1 });
  clients.add(ws);

  // Send full buffer to new client
  if (outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: "buffer", data: outputBuffer }));
  }
  if (eventBuffer.length > 0) {
    ws.send(JSON.stringify({ type: "code_agent_events", data: eventBuffer }));
  }

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

        ws.send(
          JSON.stringify({
            type: "stdin_error",
            error: "Claude Code CLI print session is non-interactive",
          }),
        );
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

async function shutdown(exitCode = 0) {
  log("info", "Starting graceful shutdown", { exitCode });

  // Notify clients with exit code (sent directly, not wrapped in data)
  appendEvent({
    type: "final",
    status: exitCode === 0 ? "completed" : "failed",
    exit_code: exitCode,
  });
  const exitMessage = JSON.stringify({ type: "exit", code: exitCode });
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(exitMessage);
    }
  }

  // Close all client connections
  for (const client of clients) {
    client.close();
  }

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
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync("/home/user/attachments", { recursive: true });
mkdirSync("/home/user/output", { recursive: true });

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
  "/home/user": { allowedTools: ["*"], hasTrustDialogAccepted: true },
  "/": { allowedTools: ["*"], hasTrustDialogAccepted: true },
};

writeFileSync(join(home, ".claude.json"), JSON.stringify(config));
writeFileSync(join(home, ".claude", "projects.json"), JSON.stringify(projects));

// Modern per-project settings: Claude Code >= 1.x stores trust per directory
// in ~/.claude/settings.json under an allowedDirectories array.
const settingsPath = join(home, ".claude", "settings.json");
const settings = {
  allowedDirectories: ["/home/user", "/"],
  ...(CLAUDE_CODE_FAST_MODE ? { fastMode: true } : {}),
};
writeFileSync(settingsPath, JSON.stringify(settings));

log("info", "Configuration written");

// Clone GitHub repo if specified
let workDir = "/home/user";
const REPO_WORKDIR = "/home/user/workspace";

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
    (value) => typeof value === "string" && value.startsWith("/home/user/"),
  );
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
        appendOutput(
          "stdout",
          `[Claude tool] ${part.name}${paths.length ? ` ${paths.join(", ")}` : ""}\n`,
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

async function runClaudeCli() {
  const sanitizedGoal = GOAL.replace(/\0/g, "");
  const prompt = `Task:\n${sanitizedGoal}`;

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
  args.push(prompt);

  const child = spawn("claude", args, {
    cwd: workDir,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

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

  child.on("error", async (err) => {
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
    await shutdown(1);
  });

  child.on("close", async (code) => {
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
    const exitCode = Number.isInteger(code) ? code : 1;
    log("info", "Claude Code CLI exited", { exitCode, sawResult });
    await shutdown(exitCode);
  });
}

runClaudeCli();
