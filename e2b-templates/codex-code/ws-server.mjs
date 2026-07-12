#!/usr/bin/env node
import { WebSocketServer } from "ws";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { spawn, execFileSync } from "child_process";
import { createServer } from "http";
import { homedir } from "os";
import { join } from "path";

const LOG_FILE = "/tmp/codex-ws-server.log";
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({ timestamp, level, message, ...data });
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Best-effort diagnostic log only.
  }
}

const PORT = 3000;
const GOAL = process.env.CODEX_GOAL;
const CODEX_AUTH_JSON = process.env.CODEX_AUTH_JSON;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.6-terra";
const CODE_AGENT_SYSTEM_PROMPT = process.env.CODE_AGENT_SYSTEM_PROMPT || "";
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CODEX_FAST_MODE_PROXY_URL = process.env.CODEX_FAST_MODE_PROXY_URL;
const CODEX_FAST_MODE_PROXY_PORT = Number(
  process.env.CODEX_FAST_MODE_PROXY_PORT || "37441",
);

if (!GOAL) {
  log("error", "CODEX_GOAL not set");
  process.exit(1);
}
if (!CODEX_AUTH_JSON && !OPENAI_API_KEY) {
  log("error", "Neither CODEX_AUTH_JSON nor OPENAI_API_KEY set");
  process.exit(1);
}

let outputBuffer = "";
let eventBuffer = [];
let exitCode = null;
let processExited = false;
let stdoutLineBuffer = "";
const clients = new Set();
const wss = new WebSocketServer({ port: PORT });

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function appendOutput(type, data) {
  outputBuffer += data;
  broadcast(type, data);
}

function appendEvent(event) {
  const normalized = {
    version: 1,
    provider: "codex",
    timestamp: new Date().toISOString(),
    ...event,
  };
  eventBuffer.push(normalized);
  broadcast("code_agent_event", normalized);
}

function describeFileChanges(changes = []) {
  return changes
    .map((change) => {
      const kind = change.kind || "change";
      const path = change.path || "<unknown>";
      return `${kind} ${path}`;
    })
    .join(", ");
}

function renderCodexJsonLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line.endsWith("\n") ? line : `${line}\n`;
  }

  if (event.type === "thread.started") {
    appendEvent({
      type: "session",
      raw_type: event.type,
      thread_id: event.thread_id || null,
    });
    return `[Codex] Thread started: ${event.thread_id || "unknown"}\n`;
  }
  if (event.type === "turn.started") {
    appendEvent({ type: "turn", raw_type: event.type, status: "started" });
    return "[Codex] Turn started\n";
  }
  if (event.type === "turn.completed") {
    const usage = event.usage || {};
    appendEvent({ type: "usage", raw_type: event.type, usage });
    return (
      [
        "[Codex] Turn completed",
        `input_tokens=${usage.input_tokens ?? 0}`,
        `cached_input_tokens=${usage.cached_input_tokens ?? 0}`,
        `output_tokens=${usage.output_tokens ?? 0}`,
        `reasoning_output_tokens=${usage.reasoning_output_tokens ?? 0}`,
      ].join(" ") + "\n"
    );
  }
  if (event.type === "turn.failed") {
    const message = event.error?.message || event.message || "unknown error";
    appendEvent({
      type: "error",
      raw_type: event.type,
      message,
      error: event.error || null,
    });
    return `[Codex] Turn failed: ${message}\n`;
  }
  if (event.type === "error") {
    const message =
      event.message || event.error?.message || JSON.stringify(event);
    appendEvent({
      type: "error",
      raw_type: event.type,
      message,
      error: event.error || null,
    });
    return `[Codex] Error: ${message}\n`;
  }

  const item = event.item;
  if (!item) return "";

  if (item.type === "agent_message" && item.text) {
    appendEvent({
      type: "agent_message",
      raw_type: event.type,
      text: item.text,
    });
    return `[Codex] ${item.text}\n`;
  }

  if (item.type === "file_change" && event.type === "item.completed") {
    const paths = (item.changes || [])
      .map((change) => change.path)
      .filter(Boolean);
    appendEvent({
      type: "file_change",
      raw_type: event.type,
      status: item.status || "completed",
      changes: item.changes || [],
      paths,
    });
    return `[Codex file_change ${item.status || "completed"}] ${describeFileChanges(item.changes)}\n`;
  }

  if (item.type === "command_execution") {
    if (event.type === "item.started") {
      appendEvent({
        type: "command",
        raw_type: event.type,
        status: "started",
        command: item.command,
      });
      return `[Codex command started] ${item.command}\n`;
    }

    appendEvent({
      type: "command",
      raw_type: event.type,
      status: "completed",
      command: item.command,
      output: item.aggregated_output || "",
      exit_code: item.exit_code ?? null,
    });
    const output = item.aggregated_output
      ? `\n${item.aggregated_output.replace(/\n?$/, "\n")}`
      : "\n";
    return [
      `[Codex command completed] ${item.command}`,
      `[Codex command output]${output}`,
      `[Codex exit_code] ${item.exit_code ?? "unknown"}\n`,
    ].join("\n");
  }

  return "";
}

function appendCodexStdout(data) {
  stdoutLineBuffer += data;
  const lines = stdoutLineBuffer.split("\n");
  stdoutLineBuffer = lines.pop() || "";
  for (const line of lines) {
    appendOutput("stdout", renderCodexJsonLine(line));
  }
}

async function shutdown(code = 0) {
  log("info", "Starting graceful shutdown", { code });
  if (codexFastModeProxy) {
    await new Promise((resolve) => codexFastModeProxy.server.close(resolve));
  }
  for (const client of clients) {
    if (client.readyState === 1)
      client.send(JSON.stringify({ type: "exit", code }));
    client.close();
  }
  wss.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 5000);
}

wss.on("connection", (ws) => {
  log("info", "Client connected", { total: clients.size + 1 });
  clients.add(ws);

  if (outputBuffer.length > 0)
    ws.send(JSON.stringify({ type: "buffer", data: outputBuffer }));
  if (eventBuffer.length > 0)
    ws.send(JSON.stringify({ type: "code_agent_events", data: eventBuffer }));
  if (processExited)
    ws.send(JSON.stringify({ type: "exit", code: exitCode ?? 0 }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "stdin") {
        ws.send(
          JSON.stringify({
            type: "stdin_error",
            error: "Codex exec is non-interactive",
          }),
        );
      }
    } catch (err) {
      log("error", "Failed to parse message", { error: err.message });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    log("info", "Client disconnected", { total: clients.size });
  });
  ws.on("error", (err) => {
    clients.delete(ws);
    log("error", "Client error", { error: err.message });
  });
});

process.on("SIGINT", () => shutdown(exitCode ?? 0));
process.on("SIGTERM", () => shutdown(exitCode ?? 0));

log("info", "Server listening", { port: PORT });

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function proxyHeaders(headers) {
  const out = {};
  const skip = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (skip.has(key.toLowerCase()) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function startCodexFastModeProxy() {
  if (!CODEX_FAST_MODE_PROXY_URL) return null;

  const targetBase = new URL(CODEX_FAST_MODE_PROXY_URL.replace(/\/$/, ""));
  const server = createServer(async (req, res) => {
    try {
      const body = await collectBody(req);
      const target = new URL(
        `${targetBase.pathname}${req.url || "/"}`,
        targetBase.origin,
      );
      const headers = proxyHeaders(req.headers);
      const method = req.method || "GET";
      const upstream = await fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        if (
          ![
            "content-encoding",
            "content-length",
            "connection",
            "transfer-encoding",
          ].includes(key.toLowerCase())
        ) {
          res.setHeader(key, value);
        }
      });
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      res.end(responseBody);
      const cacheHeader = upstream.headers.get("x-fast-mode-cache") || null;
      log("info", "Codex Fast Mode proxy request", {
        method,
        path: req.url,
        status: upstream.status,
        cache: cacheHeader,
      });
      appendEvent({
        type: "fast_cache_proxy_request",
        raw_type: "codex_fast_mode_proxy_request",
        method,
        path: req.url,
        status: upstream.status,
        cache: cacheHeader,
      });
    } catch (err) {
      log("error", "Codex Fast Mode proxy failed", { error: err.message });
      appendEvent({
        type: "fast_cache_proxy_error",
        raw_type: "codex_fast_mode_proxy_error",
        method: req.method || "GET",
        path: req.url,
        error: err.message,
      });
      res.statusCode = 502;
      res.end(JSON.stringify({ error: "Codex Fast Mode proxy failed" }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CODEX_FAST_MODE_PROXY_PORT, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${CODEX_FAST_MODE_PROXY_PORT}`;
  const sanitizedTarget = CODEX_FAST_MODE_PROXY_URL.replace(
    /\/[^/]*$/,
    "/<goalHash>",
  );
  log("info", "Codex Fast Mode proxy listening", {
    baseUrl,
    target: sanitizedTarget,
  });
  appendEvent({
    type: "fast_cache_proxy_started",
    raw_type: "codex_fast_mode_proxy_started",
    base_url: baseUrl,
    target: sanitizedTarget,
  });
  return { server, baseUrl };
}

let codexFastModeProxy = await startCodexFastModeProxy();

const home = homedir();
const codexHome = join(home, ".codex");
mkdirSync(codexHome, { recursive: true });
mkdirSync("/home/user/attachments", { recursive: true });
mkdirSync("/home/user/output", { recursive: true });

if (CODEX_AUTH_JSON) {
  try {
    JSON.parse(CODEX_AUTH_JSON);
    writeFileSync(join(codexHome, "auth.json"), CODEX_AUTH_JSON);
    log("info", "Wrote Codex ChatGPT auth envelope");
  } catch (err) {
    log("error", "CODEX_AUTH_JSON is not valid JSON", { error: err.message });
    process.exit(1);
  }
} else {
  const login = spawn("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: codexHome, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  login.stdin.end(`${OPENAI_API_KEY}\n`);
  login.stdout.on("data", (data) => appendOutput("stdout", data.toString()));
  login.stderr.on("data", (data) => appendOutput("stderr", data.toString()));
  const loginCode = await new Promise((resolve) => login.on("close", resolve));
  if (loginCode !== 0) {
    log("error", "Codex API-key login failed", { loginCode });
    process.exit(1);
  }
}

let workDir = "/home/user";
const REPO_WORKDIR = "/home/user/workspace";
if (GITHUB_REPO_URL) {
  try {
    const parsed = new URL(GITHUB_REPO_URL);
    if (!parsed.pathname.split("/").filter(Boolean).pop()) {
      throw new Error(`Invalid GitHub URL: ${GITHUB_REPO_URL}`);
    }
    workDir = REPO_WORKDIR;
    if (GITHUB_TOKEN) {
      parsed.username = "x-access-token";
      parsed.password = GITHUB_TOKEN;
    }
    execFileSync("git", ["clone", parsed.toString(), workDir], {
      stdio: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    execFileSync("git", ["config", "user.name", "Rose Agent"], {
      cwd: workDir,
    });
    execFileSync("git", ["config", "user.email", "agent@roselabs.ai"], {
      cwd: workDir,
    });
    writeFileSync(join(workDir, "AGENTS.md"), CODE_AGENT_SYSTEM_PROMPT);
    log("info", "Repository cloned", { workDir });
  } catch (err) {
    appendOutput(
      "stderr",
      `[Setup] Failed to clone repository: ${err.message}\n`,
    );
    log("error", "Failed to clone repository", { error: err.message });
  }
}

if (!GITHUB_REPO_URL && CODE_AGENT_SYSTEM_PROMPT) {
  writeFileSync(join(workDir, "AGENTS.md"), CODE_AGENT_SYSTEM_PROMPT);
}

appendEvent({
  type: "session",
  status: "starting",
  cwd: workDir,
  model: CODEX_MODEL,
  prompt_version:
    CODE_AGENT_SYSTEM_PROMPT.match(
      /Rose Labs code-agent instructions \(([^)]+)\)/,
    )?.[1] || null,
});

const sanitizedGoal = [
  CODE_AGENT_SYSTEM_PROMPT
    ? `System instructions:\n${CODE_AGENT_SYSTEM_PROMPT}`
    : "",
  `Task:\n${GOAL.replace(/\0/g, "")}`,
]
  .filter(Boolean)
  .join("\n\n");
const args = [
  "exec",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
  "--json",
  "--cd",
  workDir,
  "-m",
  CODEX_MODEL,
  sanitizedGoal,
];
if (codexFastModeProxy) {
  args.splice(
    1,
    0,
    "-c",
    `chatgpt_base_url="${codexFastModeProxy.baseUrl}"`,
    "-c",
    'model_provider="fastmode"',
    "-c",
    `model_providers.fastmode={name="fastmode",base_url="${codexFastModeProxy.baseUrl}/backend-api/codex",wire_api="responses"}`,
  );
}

log("info", "Starting Codex exec", {
  model: CODEX_MODEL,
  workDir,
  goal: sanitizedGoal.slice(0, 120),
});
const codex = spawn("codex", args, {
  cwd: workDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: home,
    TERM: "xterm-256color",
  },
});

codex.stdout.on("data", (data) => appendCodexStdout(data.toString()));
codex.stderr.on("data", (data) => appendOutput("stderr", data.toString()));
codex.on("error", (err) => {
  appendOutput("stderr", `[Codex] Failed to start: ${err.message}\n`);
  log("error", "Codex spawn error", { error: err.message });
});
codex.on("close", (code, signal) => {
  if (stdoutLineBuffer) {
    appendOutput("stdout", renderCodexJsonLine(stdoutLineBuffer));
    stdoutLineBuffer = "";
  }
  exitCode = code ?? 1;
  processExited = true;
  appendEvent({
    type: "final",
    status: exitCode === 0 ? "completed" : "failed",
    exit_code: exitCode,
    signal,
  });
  log("info", "Codex exited", { code, signal });
  broadcast("exit", exitCode);
  setTimeout(() => shutdown(exitCode ?? 0), 120000);
});
