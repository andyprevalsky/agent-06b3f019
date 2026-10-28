#!/usr/bin/env node
import { WebSocketServer } from "ws";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { spawn, execFileSync } from "child_process";
import { timingSafeEqual } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";

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

// E2B serves the template on 3000; a local run (tests, a local target) picks
// its own port.
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const GOAL = process.env.CODEX_GOAL;
const CODEX_AUTH_JSON = process.env.CODEX_AUTH_JSON;
// Funded fallback: our Azure OpenAI deployment (Responses API), selected with
// -c model_provider flags; the key is read from AZURE_OPENAI_API_KEY by Codex.
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const CODEX_AZURE_BASE_URL = process.env.CODEX_AZURE_BASE_URL || "";
const CODEX_AZURE_MODEL = process.env.CODEX_AZURE_MODEL || "";
const FUNDED_PROVIDER = Boolean(
  AZURE_OPENAI_API_KEY && CODEX_AZURE_BASE_URL && CODEX_AZURE_MODEL,
);
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.6-terra";
const CODE_AGENT_SYSTEM_PROMPT = process.env.CODE_AGENT_SYSTEM_PROMPT || "";
// Backend-provided Mobbin MCP bearer (design references); unset = no Mobbin server.
const MOBBIN_MCP_TOKEN = process.env.MOBBIN_MCP_TOKEN || "";
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GOAL) {
  log("error", "CODEX_GOAL not set");
  process.exit(1);
}
if (!CODEX_AUTH_JSON && !FUNDED_PROVIDER) {
  log("error", "Neither CODEX_AUTH_JSON nor the Azure funded provider set");
  process.exit(1);
}

const CODEX_TRANSPORT = process.env.CODEX_TRANSPORT || "app-server";

let outputBuffer = "";
let eventBuffer = [];
let exitCode = null;
let processExited = false;
let stdoutLineBuffer = "";
// Set when a Codex turn proves the ChatGPT OAuth credential unusable. Drives the
// runtime fallback to the funded OpenAI API key (see the run-with-fallback block
// below). A credential can be DB-valid yet revoked or over quota, so this only
// surfaces mid-run — a null-credential fallback in the backend cannot catch it.
let oauthFallbackReason = null;
const clients = new Set();

// ---------------------------------------------------------------------------
// Inbound user turns (agent-graph messages, direct chat)
// ---------------------------------------------------------------------------
//
//   backend / agents helper ──user_turn{id,token,text,sender}──► this server
//          ◄──user_turn_ack{id,status}── dedupe by id (delivered once)
//
// `codex exec` reads one prompt, so a delivered turn is queued and runs as the
// next turn of the same thread (`codex exec … resume <thread_id> <text>`)
// right after the current run exits cleanly. Same protocol and token as the
// Claude Code ws-server (codeSessionTurns.ts / code_session_turns.py).
// Turn state lives here (the renderer and run loop use it); the token-checked
// handler is defined after shutdown().
const queuedTurns = [];
let turnsClosed = false;
let codexThreadId = null;
let nativeCodex = null;

// After Codex exits the server keeps serving its final buffer until the
// session is closed, so a detached or retried activity can always reattach.
// There is no linger deadline: an unattended sandbox pauses on its E2B idle
// window. Closing the session (SIGTERM / sandbox pause or kill) exits at once.

function classifyOAuthFallbackReason(message) {
  // Restricted to explicit ChatGPT/OpenAI plan-exhaustion wording. Broad terms
  // like a bare "quota" or "hit your usage" can match unrelated sandbox tooling
  // errors (disk/rate quotas) and would trigger a wasteful funded-key retry that
  // masks the real failure. The billing-exhaustion tells below are all specific
  // to the OpenAI/ChatGPT plan being out of quota: "insufficient_quota" is the
  // OpenAI error code, and "Quota exceeded. Check your plan and billing details."
  // is the plan-exhaustion message returned on the responses API (only "usage
  // limit"/"purchase more credits" wording was matched before, so this exact
  // message slipped past and the funded-key fallback never fired).
  const text = String(message || "");
  if (
    /usage[ _]limit|usage_limit_reached|hit your usage limit|purchase more credits|insufficient[_ ]quota|check your plan and billing/i.test(
      text,
    )
  ) {
    return "usage_limit_reached";
  }
  // Called only for typed Codex error/turn.failed events, using the complete
  // message (including continuation lines), never command output or agent text.
  // Keep explicit revocation markers aligned with computeGrantFailure.ts.
  if (
    /\b(?:token_revoked|refresh_token_invalidated|refresh_token_reused|refresh_token_expired|invalid_refresh_token|invalid_grant)\b|oauth (?:access )?token has been revoked|refresh token (?:was )?revoked|refresh token not found or invalid|access token could not be refreshed|your session has ended|log ?out and sign in again/i.test(
      text,
    )
  ) {
    return "oauth_refresh_invalid";
  }
  return null;
}
// C15: Codex's own rate-limit snapshot (the rollout's latest `token_count`
// event: rate_limits.{primary,secondary}.used_percent / resets_at and
// rate_limit_reached_type) says whether a failed turn hit a usage limit. A
// structured signal, so the code-agent activity never classifies prose.
function newestCodexRollout() {
  const root = join(homedir(), ".codex", "sessions");
  let newest = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        const mtime = statSync(path).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path, mtime };
      }
    }
  };
  walk(root, 0);
  return newest?.path ?? null;
}

function codexUsageLimit() {
  const rollout = newestCodexRollout();
  if (!rollout) return null;
  let limits = null;
  try {
    const text = readFileSync(rollout, "utf8").slice(-512 * 1024);
    for (const line of text.split("\n").reverse()) {
      if (!line.includes('"token_count"')) continue;
      try {
        const entry = JSON.parse(line);
        if (
          entry?.type === "event_msg" &&
          entry.payload?.type === "token_count"
        ) {
          limits = entry.payload.rate_limits ?? null;
          if (limits) break;
        }
      } catch {
        // a torn line while Codex is writing
      }
    }
  } catch {
    return null;
  }
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary].filter(Boolean);
  const exhausted = windows.filter(
    (window) => Number(window.used_percent) >= 100,
  );
  if (!limits.rate_limit_reached_type && exhausted.length === 0) return null;
  const resets = (exhausted.length > 0 ? exhausted : windows)
    .map((window) => window.resets_at)
    .filter((value) => typeof value === "number");
  return {
    reached_type: limits.rate_limit_reached_type ?? null,
    resets_at: resets.length > 0 ? Math.max(...resets) : null,
  };
}

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
    ...(typeof CODEX_TRANSPORT !== "undefined" &&
    CODEX_TRANSPORT === "app-server"
      ? { seq: eventBuffer.length + 1 }
      : {}),
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
    if (typeof event.thread_id === "string" && event.thread_id) {
      codexThreadId = event.thread_id;
    }
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
    oauthFallbackReason ??= classifyOAuthFallbackReason(message);
    const usageLimit = codexUsageLimit();
    appendEvent({
      type: "error",
      raw_type: event.type,
      message,
      error: event.error || null,
      ...(usageLimit ? { usage_limit: usageLimit } : {}),
    });
    return `[Codex] Turn failed: ${message}\n`;
  }
  if (event.type === "error") {
    const message =
      event.message || event.error?.message || JSON.stringify(event);
    oauthFallbackReason ??= classifyOAuthFallbackReason(message);
    const usageLimit = codexUsageLimit();
    appendEvent({
      type: "error",
      raw_type: event.type,
      message,
      error: event.error || null,
      ...(usageLimit ? { usage_limit: usageLimit } : {}),
    });
    return `[Codex] Error: ${message}\n`;
  }

  const item = event.item;
  if (!item) return "";

  // `item_id` pairs an item's started/completed events (transcript rows).
  const itemId = typeof item.id === "string" ? item.id : null;

  if (item.type === "agent_message" && item.text) {
    appendEvent({
      type: "agent_message",
      raw_type: event.type,
      text: item.text,
      item_id: itemId,
    });
    return `[Codex] ${item.text}\n`;
  }

  if (item.type === "reasoning" && event.type === "item.completed") {
    appendEvent({
      type: "thinking",
      raw_type: event.type,
      text: typeof item.text === "string" ? item.text : "",
      redacted: !item.text,
      item_id: itemId,
    });
    return "";
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
      item_id: itemId,
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
        item_id: itemId,
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
      item_id: itemId,
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
  nativeCodex?.child.kill("SIGTERM");
  for (const client of clients) {
    if (client.readyState === 1)
      client.send(JSON.stringify({ type: "exit", code }));
    client.close();
  }
  wss.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 5000);
}

// Token-checked user_turn handler (see "Inbound user turns" above).
const TURN_TOKEN = process.env.CODE_SESSION_TURN_TOKEN || "";
const MAX_TURN_TEXT_CHARS = 100_000;
const MAX_TURN_ID_CHARS = 128;
const deliveredTurnIds = new Set();
const inFlightTurnIds = new Set();
const nativeDeliveryAcks = new Map();

function tokenMatches(candidate) {
  if (!TURN_TOKEN || typeof candidate !== "string") return false;
  const expected = Buffer.from(TURN_TOKEN, "utf8");
  const actual = Buffer.from(candidate, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function turnAck(id, status, reason) {
  return { type: "user_turn_ack", id, status, ...(reason ? { reason } : {}) };
}

async function handleUserTurn(msg) {
  const id = typeof msg.id === "string" ? msg.id : "";
  if (!tokenMatches(msg.token)) return turnAck(id, "rejected", "unauthorized");
  if (!id || id.length > MAX_TURN_ID_CHARS) {
    return turnAck(id, "rejected", "invalid_id");
  }
  if (deliveredTurnIds.has(id))
    return {
      ...(nativeDeliveryAcks.get(id) || turnAck(id, "duplicate")),
      status: "duplicate",
    };
  if (inFlightTurnIds.has(id))
    return turnAck(id, "rejected", "delivery_in_progress_retry");
  const text = typeof msg.text === "string" ? msg.text.replace(/\0/g, "") : "";
  if (
    (!text.trim() && !msg.attachments?.length) ||
    text.length > MAX_TURN_TEXT_CHARS
  ) {
    return turnAck(id, "rejected", "invalid_text");
  }
  if (turnsClosed) return turnAck(id, "rejected", "session_ended");
  const sender = msg.sender === "agent" ? "agent" : "user";
  if (CODEX_TRANSPORT === "app-server") {
    inFlightTurnIds.add(id);
    try {
      if (!nativeCodex) return turnAck(id, "rejected", "session_starting");
      if (nativeCodex.initialization) await nativeCodex.initialization;
      const input = [
        { type: "text", text, text_elements: [] },
        ...stageDirectAttachments(id, msg.attachments),
      ];
      const effective = await nativeCodex.deliver(msg, input);
      deliveredTurnIds.add(id);
      appendEvent({
        type: "user_turn",
        turn_id: effective.turn_id,
        request_id: id,
        client_message_id: id,
        sender,
        text,
        attachments: (msg.attachments || []).map(({ name, mime_type }) => ({
          name,
          mime_type,
        })),
      });
      const ack = { ...turnAck(id, "delivered"), ...effective };
      nativeDeliveryAcks.set(id, ack);
      return ack;
    } catch (error) {
      return turnAck(id, "rejected", error.message);
    } finally {
      inFlightTurnIds.delete(id);
    }
  }
  deliveredTurnIds.add(id);
  queuedTurns.push({ id, sender, text });
  appendEvent({ type: "user_turn", turn_id: id, sender, text });
  appendOutput("stdout", `[${sender === "user" ? "You" : "Agent"}] ${text}\n`);
  log("info", "Queued user turn", { id, sender, chars: text.length });
  return turnAck(id, "delivered");
}

wss.on("connection", (ws, req) => {
  log("info", "Client connected", { total: clients.size + 1 });
  clients.add(ws);

  // `?replay=0`: a control connection (direct-chat turn) skips the history.
  let replay = true;
  try {
    replay =
      new URL(req?.url || "/", "http://localhost").searchParams.get(
        "replay",
      ) !== "0";
  } catch {
    replay = true;
  }
  if (replay && outputBuffer.length > 0)
    ws.send(JSON.stringify({ type: "buffer", data: outputBuffer }));
  const cursor = Number(
    new URL(req?.url || "/", "http://localhost").searchParams.get("cursor") ||
      0,
  );
  if (replay && eventBuffer.length > 0)
    ws.send(
      JSON.stringify({
        type: "code_agent_events",
        data: eventBuffer.filter((event) => !event.seq || event.seq > cursor),
      }),
    );
  if (processExited)
    ws.send(JSON.stringify({ type: "exit", code: exitCode ?? 0 }));

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "stdin") {
        ws.send(
          JSON.stringify({
            type: "stdin_error",
            error: "Codex exec is non-interactive",
          }),
        );
      } else if (msg.type === "session_capabilities") {
        if (!tokenMatches(msg.token))
          ws.send(
            JSON.stringify({
              type: "session_capabilities_ack",
              status: "rejected",
              reason: "unauthorized",
            }),
          );
        else if (!nativeCodex?.ready)
          ws.send(
            JSON.stringify({
              type: "session_capabilities_ack",
              status: "rejected",
              reason: "session_starting",
            }),
          );
        else
          ws.send(
            JSON.stringify({
              type: "session_capabilities_ack",
              status: "delivered",
              code_provider: "codex",
              effective_settings: nativeCodex.settings,
              models: nativeCodex.models.map((model) => ({
                model: model.model || model.id,
                label: model.displayName || model.model || model.id,
                efforts: (model.supportedReasoningEfforts || []).map(
                  (e) => e.reasoningEffort,
                ),
                speeds: [
                  "standard",
                  ...(model.serviceTiers || []).map((t) => t.id),
                ].filter((value, index, all) => all.indexOf(value) === index),
              })),
            }),
          );
      } else if (msg.type === "user_turn") {
        ws.send(JSON.stringify(await handleUserTurn(msg)));
      } else if (msg.type === "hand_back") {
        // Codex has no direct-chat hold: queued turns always run in order.
        ws.send(JSON.stringify({ type: "hand_back_ack", status: "not_held" }));
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

const home = homedir();
const codexHome = join(home, ".codex");
// Same contract as the Claude Code ws-server: ROSE_PROJECT_WORKDIR names an
// existing folder to work in (a restored project, or the folder a user granted
// to the Rose Mac app). That folder is never cloned into or given an AGENTS.md,
// and the session's scratch dirs stay under HOME.
const PROJECT_WORKDIR = process.env.ROSE_PROJECT_WORKDIR || "";
const projectMode = Boolean(PROJECT_WORKDIR) && existsSync(PROJECT_WORKDIR);
mkdirSync(codexHome, { recursive: true });
mkdirSync(join(home, "attachments"), { recursive: true });
mkdirSync(join(home, "output"), { recursive: true });

// The funded provider needs no login: Codex reads AZURE_OPENAI_API_KEY via the
// provider's env_key. Dropping the ChatGPT auth.json keeps OAuth out of the run.
function useFundedProvider() {
  try {
    rmSync(join(codexHome, "auth.json"), { force: true });
  } catch {
    // Best-effort: the azure provider never reads auth.json.
  }
  log("info", "Using the Azure OpenAI funded provider", {
    model: CODEX_AZURE_MODEL,
  });
  return true;
}

/** Codex -c flags that select the Azure OpenAI funded provider. */
function fundedProviderArgs() {
  return [
    "-c",
    'model_provider="azure"',
    "-c",
    'model_providers.azure.name="Azure OpenAI"',
    "-c",
    `model_providers.azure.base_url=${JSON.stringify(CODEX_AZURE_BASE_URL)}`,
    "-c",
    'model_providers.azure.env_key="AZURE_OPENAI_API_KEY"',
    "-c",
    'model_providers.azure.wire_api="responses"',
  ];
}

// usingApiKey tracks whether the ACTIVE credential is the funded Azure provider
// (vs. the ChatGPT OAuth token). It gates the one-shot runtime fallback below.
let usingApiKey = false;
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
  useFundedProvider();
  usingApiKey = true;
}

const CODEX_RESUME_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/.test(
  (process.env.CODEX_RESUME_SESSION_ID || "").trim(),
)
  ? process.env.CODEX_RESUME_SESSION_ID.trim()
  : null;

// home is /home/user in the E2B template.
let workDir = projectMode ? PROJECT_WORKDIR : home;
const REPO_WORKDIR = join(home, "workspace");
// A resumed persistent code session already holds the repo (local branches,
// commits, uncommitted edits): refresh the credentialed remote, never re-clone.
if (GITHUB_REPO_URL && !projectMode && existsSync(join(REPO_WORKDIR, ".git"))) {
  workDir = REPO_WORKDIR;
  try {
    const parsed = new URL(GITHUB_REPO_URL);
    if (GITHUB_TOKEN) {
      parsed.username = "x-access-token";
      parsed.password = GITHUB_TOKEN;
    }
    try {
      execFileSync("git", ["remote", "set-url", "origin", parsed.toString()], {
        cwd: workDir,
      });
    } catch {
      execFileSync("git", ["remote", "add", "origin", parsed.toString()], {
        cwd: workDir,
      });
    }
    writeFileSync(join(workDir, "AGENTS.md"), CODE_AGENT_SYSTEM_PROMPT);
    log("info", "Resuming existing repository", { workDir });
  } catch (err) {
    log("error", "Failed to refresh resumed repository", {
      error: err.message,
    });
  }
} else if (GITHUB_REPO_URL && !projectMode) {
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

// A project's own AGENTS.md is never overwritten; the goal already carries the
// code-agent instructions.
if (!GITHUB_REPO_URL && !projectMode && CODE_AGENT_SYSTEM_PROMPT) {
  writeFileSync(join(workDir, "AGENTS.md"), CODE_AGENT_SYSTEM_PROMPT);
}

// Persistent code sessions work on their own branch (code-agent-persistent-
// sessions.md §1b); same contract as the Claude Code ws-server.
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
  return result;
}

const codeSessionBranch =
  GITHUB_REPO_URL && workDir === REPO_WORKDIR
    ? prepareCodeSessionBranch(REPO_WORKDIR)
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

appendEvent({
  type: "session",
  status: "starting",
  cwd: workDir,
  model: usingApiKey ? CODEX_AZURE_MODEL : CODEX_MODEL,
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
// The ChatGPT fast-mode proxy only makes sense for the OAuth token — it forwards
// to the ChatGPT codex backend, which won't authenticate an OpenAI API key. So
// the API-key path (initial or fallback) runs against the default OpenAI endpoint.
function buildCodexArgs({ resume = null } = {}) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    // Code agents cannot ask the user questions: keep request_user_input out of
    // Default mode (codex-rs/tools/src/tool_config.rs:6; feature key
    // codex-rs/features/src/lib.rs:1761). runCodexAppServer copies every -c.
    "-c",
    "features.default_mode_request_user_input=false",
    "--json",
    "--cd",
    workDir,
    "-m",
    usingApiKey ? CODEX_AZURE_MODEL : CODEX_MODEL,
    // A queued inbound turn continues the current thread; otherwise a
    // persistent code session continues its previous Codex conversation.
    ...(resume
      ? ["resume", resume.threadId, resume.text]
      : CODEX_RESUME_SESSION_ID
        ? ["resume", CODEX_RESUME_SESSION_ID, sanitizedGoal]
        : [sanitizedGoal]),
  ];
  // Rose agent tools as an MCP server (the backend writes ~/.rose/bin/rose at
  // session create). --ignore-user-config skips config.toml, so register it
  // with -c. The tool call deadline is set past any real upload (C11: no
  // code-agent timeouts).
  if (usingApiKey) args.splice(1, 0, ...fundedProviderArgs());
  const roseCli = join(home, ".rose", "bin", "rose");
  if (existsSync(roseCli)) {
    args.splice(
      1,
      0,
      "-c",
      'mcp_servers.rose.command="node"',
      "-c",
      `mcp_servers.rose.args=[${JSON.stringify(roseCli)},"mcp"]`,
      "-c",
      "mcp_servers.rose.tool_timeout_sec=31536000",
    );
  }
  // Mobbin design references when the backend supplied its token. The token is
  // one Mobbin account's, so only the catalog search tools are enabled.
  if (MOBBIN_MCP_TOKEN) {
    args.splice(
      1,
      0,
      "-c",
      'mcp_servers.mobbin.url="https://api.mobbin.com/mcp"',
      "-c",
      'mcp_servers.mobbin.bearer_token_env_var="MOBBIN_MCP_TOKEN"',
      "-c",
      'mcp_servers.mobbin.enabled_tools=["search_screens","search_flows","search_sections"]',
    );
  }
  return args;
}

function runCodex(args) {
  return new Promise((resolve) => {
    log("info", "Starting Codex exec", {
      model: usingApiKey ? CODEX_AZURE_MODEL : CODEX_MODEL,
      workDir,
      usingApiKey,
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
      log("info", "Codex run exited", { code, signal, usingApiKey });
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

// Native Codex app-server transport. JSON-RPC is newline-delimited on stdio;
// the process stays alive between turns so Send can steer the active turn.
class CodexAppServer {
  constructor(child, emit, defaults, handoff = null) {
    this.child = child;
    this.emit = emit;
    this.settings = defaults;
    // { schema, write }: the goal turn's final message becomes the handoff file.
    this.handoff = handoff;
    this.handoffSchema = handoff ? strictOutputSchema(handoff.schema) : null;
    this.handoffTurnId = null;
    this.handoffText = null;
    this.pending = new Map();
    this.nextId = 1;
    this.activeTurnId = null;
    this.threadId = null;
    this.rows = new Map();
    this.endedTurnIds = new Set();
    this.rateLimits = null;
    this.settingsVersion = 0;
    this.turnStartedAt = null;
    this.ready = false;
    this.controlBusy = false;
    // turn id -> turn/start arguments, so a credential fallback can re-send it.
    this.turnStarts = new Map();
    // (turn, error) => true when a credential fallback takes over a failed turn.
    this.recoverFailedTurn = null;
    this.pendingTurnStart = null;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        try {
          this.receive(JSON.parse(line));
        } catch (error) {
          log("warn", "Invalid app-server notification", {
            error: error.message,
          });
        }
      }
    });
    const fail = (error) => {
      this.ready = false;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("close", () => fail(new Error("app_server_closed")));
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  receive(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(message.error.message || "native_request_failed"),
        );
      else pending.resolve(message.result);
      return;
    }
    // Never silently accept a new approval method. This session uses the
    // explicit never approval policy; unexpected requests fail closed.
    if (message.id !== undefined && message.method) {
      this.child.stdin.write(
        JSON.stringify({
          id: message.id,
          error: { code: -32601, message: "Unsupported server request" },
        }) + "\n",
      );
      return;
    }
    const p = message.params || {};
    const common = {
      raw_type: message.method,
      thread_id: p.threadId || this.threadId,
      turn_id: p.turnId || p.turn?.id || this.activeTurnId,
      ...(this.turnStartedAt ? { turn_started_at: this.turnStartedAt } : {}),
    };
    if (message.method === "account/rateLimits/updated") {
      this.rateLimits = {
        ...this.rateLimits,
        ...Object.fromEntries(
          Object.entries(p.rateLimits || {}).filter(
            ([, value]) => value !== null,
          ),
        ),
      };
    } else if (message.method === "thread/settings/updated") {
      const settings = p.threadSettings;
      this.settings = {
        model: settings.model,
        effort: settings.effort,
        speed: settings.serviceTier || "standard",
      };
      this.settingsVersion++;
      this.emit({
        ...common,
        type: "settings",
        effective_settings: this.settings,
      });
    } else if (message.method === "model/rerouted") {
      this.settings = { ...this.settings, model: p.toModel };
      this.settingsVersion++;
      this.emit({
        ...common,
        type: "settings",
        effective_settings: this.settings,
        reason: p.reason,
      });
    } else if (message.method === "turn/started") {
      this.activeTurnId = p.turn.id;
      this.turnStartedAt = new Date().toISOString();
      this.emit({
        ...common,
        type: "turn_started",
        turn_started_at: this.turnStartedAt,
        status: "started",
      });
    } else if (message.method === "turn/completed") {
      this.endedTurnIds.add(p.turn.id);
      if (this.activeTurnId === p.turn.id) this.activeTurnId = null;
      const outcome = p.turn.status;
      if (
        outcome === "failed" &&
        this.recoverFailedTurn?.(p.turn, p.turn.error)
      ) {
        // The run continues on another credential: report the error, not an end.
        this.emit({
          ...common,
          type: "error",
          message: p.turn.error?.message || "Codex turn failed",
          error: p.turn.error,
          usage_limit: this.usageLimit(),
        });
        return;
      }
      if (p.turn.id === this.handoffTurnId) {
        // `codex exec --output-last-message`: the schema-constrained final
        // message is the handoff; nothing is written for an unusable one.
        this.handoffTurnId = null;
        const handoffJson =
          outcome === "completed"
            ? handoffFromFinalMessage(this.handoffText, this.handoff.schema)
            : null;
        if (handoffJson !== null) {
          try {
            this.handoff.write(handoffJson);
          } catch (error) {
            log("warn", "Could not write the handoff file", {
              error: error.message,
            });
          }
        }
      }
      this.emit({
        ...common,
        type: "turn_ended",
        turn_started_at: this.turnStartedAt,
        turn_ended_at: new Date().toISOString(),
        turn_outcome: outcome,
        status: outcome,
        outcome,
        error: p.turn.error || null,
      });
      if (outcome === "failed")
        this.emit({
          ...common,
          type: "error",
          message: p.turn.error?.message || "Codex turn failed",
          error: p.turn.error,
          usage_limit: this.usageLimit(),
        });
      this.emit({
        ...common,
        type: "final",
        status: outcome,
        exit_code: outcome === "completed" ? 0 : 1,
      });
    } else if (
      [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
      ].includes(message.method)
    ) {
      const type =
        message.method === "item/agentMessage/delta"
          ? "agent_message"
          : "thinking";
      // Summary and raw reasoning are different streams, even on one item.
      const itemId =
        type === "thinking"
          ? `${p.itemId}:${message.method.includes("summary") ? "summary" : "reasoning"}:${p.summaryIndex ?? p.contentIndex ?? 0}`
          : p.itemId;
      const key = `${p.turnId}:${itemId}`;
      const text = (this.rows.get(key) || "") + p.delta;
      this.rows.set(key, text);
      this.emit({
        ...common,
        type,
        item_id: itemId,
        text,
        delta: p.delta,
        partial: true,
      });
    } else if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item = p.item;
      const completed = message.method === "item/completed";
      const base = {
        ...common,
        item_id: item.id,
        status: completed ? "completed" : "started",
        partial: !completed,
      };
      if (item.type === "agentMessage" && completed) {
        if (p.turnId === this.handoffTurnId) this.handoffText = item.text || "";
        this.emit({ ...base, type: "agent_message", text: item.text || "" });
      } else if (item.type === "commandExecution")
        this.emit({
          ...base,
          type: "command",
          tool_kind: "shell",
          command: item.command,
          output: item.aggregatedOutput || "",
          exit_code: item.exitCode ?? null,
        });
      else if (item.type === "fileChange")
        this.emit({
          ...base,
          type: "file_change",
          tool_kind: "file",
          changes: item.changes || [],
          paths: (item.changes || []).map((c) => c.path),
        });
      else if (item.type === "mcpToolCall") {
        this.emit({
          ...base,
          type: "tool_use",
          tool_use_id: item.id,
          tool_kind: "mcp",
          tool: `${item.server}.${item.tool}`,
          input: item.arguments,
        });
        if (completed)
          this.emit({
            ...base,
            type: "tool_result",
            tool_use_id: item.id,
            tool_kind: "mcp",
            tool_use_result: JSON.stringify(item.result || item.error || {}),
            is_error: Boolean(item.error),
          });
      } else if (item.type === "webSearch")
        this.emit({
          ...base,
          type: "tool_use",
          tool_kind: "web",
          name: "web_search",
          input: item.action,
        });
    } else if (message.method === "thread/tokenUsage/updated") {
      const total = p.tokenUsage?.total || {};
      const usage = Object.fromEntries(
        [
          ["output_tokens", total.outputTokens],
          ["input_tokens", total.inputTokens],
          ["cached_input_tokens", total.cachedInputTokens],
        ].filter(
          ([, value]) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        ),
      );
      this.emit({
        ...common,
        type: "usage",
        usage_scope: "session",
        token_usage: p.tokenUsage,
        usage,
        ...usage,
      });
    } else if (message.method === "error")
      this.emit({
        ...common,
        type: "error",
        message: p.error?.message || p.message,
        error: p.error,
        usage_limit: this.usageLimit(),
      });
  }
  usageLimit() {
    const limits = this.rateLimits;
    if (!limits) return null;
    const windows = [limits.primary, limits.secondary].filter(Boolean);
    const exhausted = windows.filter((window) => window.usedPercent >= 100);
    if (!limits.rateLimitReachedType && !exhausted.length) return null;
    const resets = (exhausted.length ? exhausted : windows)
      .map((window) => window.resetsAt)
      .filter((value) => typeof value === "number");
    return {
      reached_type: limits.rateLimitReachedType || null,
      resets_at: resets.length ? Math.max(...resets) : null,
    };
  }
  async connect() {
    await this.request("initialize", {
      clientInfo: { name: "rose", title: "Rose", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const catalog = await this.request("model/list", { includeHidden: true });
    this.models = catalog.data || [];
  }
  // Re-send a failed turn on a new app-server process (same thread, same input).
  async resumeTurn(threadId, turnStart) {
    await this.connect();
    const response = await this.request("thread/resume", {
      threadId,
      model: this.settings.model,
      serviceTier:
        this.settings.speed === "standard" ? null : this.settings.speed,
      cwd: workDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    this.threadId = response.thread.id;
    const turnId = await this.start(
      turnStart.input,
      this.settings,
      turnStart.clientId,
      turnStart.outputSchema,
    );
    if (turnStart.outputSchema) this.handoffTurnId = turnId;
    this.ready = true;
  }
  async initialize(resumeId, goal) {
    await this.connect();
    // Catalog -> supported defaults -> native ACK -> first turn.
    const tiersOf = (m) => (m?.serviceTiers || []).map((t) => t.id);
    let model =
      this.models.find(
        (m) => m.model === this.settings.model || m.id === this.settings.model,
      ) || this.models.find((m) => m.isDefault);
    // The query box's Ultrafast is Codex's ultrafast service tier. A model that
    // does not offer it runs on the catalog model that does (the default first).
    if (
      this.settings.speed === "ultrafast" &&
      !tiersOf(model).includes("ultrafast")
    ) {
      const ultrafast =
        this.models.find(
          (m) => m.isDefault && tiersOf(m).includes("ultrafast"),
        ) || this.models.find((m) => tiersOf(m).includes("ultrafast"));
      if (ultrafast) {
        log("info", "Ultrafast runs on the catalog model that offers it", {
          requested: this.settings.model,
          model: ultrafast.model,
        });
        model = ultrafast;
        this.settings = { ...this.settings, model: ultrafast.model };
      }
    }
    const efforts = (model?.supportedReasoningEfforts || []).map(
      (e) => e.reasoningEffort,
    );
    const tiers = tiersOf(model);
    this.settings = {
      ...this.settings,
      effort:
        this.settings.effort ??
        (!resumeId && efforts.includes("medium") ? "medium" : null),
      speed: supportedSpeed(this.settings.speed, tiers, resumeId),
    };
    const response = await this.request(
      resumeId ? "thread/resume" : "thread/start",
      {
        ...(resumeId ? { threadId: resumeId } : {}),
        model: this.settings.model,
        serviceTier:
          this.settings.speed === "standard" ? null : this.settings.speed,
        ...(this.settings.effort
          ? { config: { model_reasoning_effort: this.settings.effort } }
          : {}),
        cwd: workDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    );
    this.threadId = response.thread.id;
    this.settings = {
      model: response.model,
      effort: response.reasoningEffort ?? this.settings.effort,
      speed: response.serviceTier || "standard",
    };
    const goalTurnId = await this.start(
      [{ type: "text", text: goal, text_elements: [] }],
      this.settings,
      undefined,
      this.handoffSchema,
    );
    if (this.handoffSchema) this.handoffTurnId = goalTurnId;
    this.ready = true;
    this.emit({
      type: "session",
      thread_id: this.threadId,
      status: "ready",
      effective_settings: this.settings,
    });
  }
  validateSettings(requested = {}) {
    const next = { ...this.settings, ...requested };
    const model = this.models.find(
      (m) => m.model === next.model || m.id === next.model,
    );
    if (!model) throw new Error("unsupported_model");
    if (
      next.effort &&
      !(model.supportedReasoningEfforts || []).some(
        (e) => e.reasoningEffort === next.effort,
      )
    )
      throw new Error("unsupported_effort");
    const tiers = (model.serviceTiers || []).map((t) => t.id);
    if (next.speed !== "standard" && !tiers.includes(next.speed))
      throw new Error("unsupported_speed");
    return next;
  }
  async start(input, settings, clientId, outputSchema = null) {
    const settingsVersion = this.settingsVersion;
    // A turn can fail in the same chunk as its turn/start response.
    const turnStart = { input, clientId, outputSchema };
    this.pendingTurnStart = turnStart;
    const response = await this.request("turn/start", {
      threadId: this.threadId,
      input,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.speed === "standard" ? null : settings.speed,
      ...(clientId ? { clientUserMessageId: clientId } : {}),
      ...(outputSchema ? { outputSchema } : {}),
    });
    this.turnStarts.set(response.turn.id, turnStart);
    if (this.pendingTurnStart === turnStart) this.pendingTurnStart = null;
    this.activeTurnId = this.endedTurnIds.has(response.turn.id)
      ? null
      : response.turn.id;
    if (this.settingsVersion === settingsVersion) this.settings = settings;
    return response.turn.id;
  }
  async deliver(msg, input) {
    if (!this.ready) throw new Error("session_starting");
    if (this.controlBusy) throw new Error("concurrent_control_retry");
    this.controlBusy = true;
    try {
      const settings = this.validateSettings(msg.settings);
      let delivery_mode;
      let turn_id;
      if (this.activeTurnId) {
        if (JSON.stringify(settings) !== JSON.stringify(this.settings))
          throw new Error("settings_change_requires_idle");
        const response = await this.request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.activeTurnId,
          input,
          clientUserMessageId: msg.id,
        });
        turn_id = response.turnId || this.activeTurnId;
        delivery_mode = "steer";
      } else {
        turn_id = await this.start(input, settings, msg.id);
        delivery_mode = "start";
      }
      return {
        delivery_mode,
        turn_id,
        effective_settings: { ...this.settings },
      };
    } finally {
      this.controlBusy = false;
    }
  }
}

// The worker appends this block to the goal (agents/domains/spawn_claude_code_agent/
// service.py:handoff_task_text); back-end CODE_AGENT_HANDOFF_PATH names the file.
const CODE_AGENT_HANDOFF_PATH = "/home/user/.rose/handoff.json";
const HANDOFF_SCHEMA_MARKER = `\n\nResult JSON Schema for ${CODE_AGENT_HANDOFF_PATH}:\n`;

function handoffSchemaFromGoal(goal) {
  const at =
    typeof goal === "string" ? goal.lastIndexOf(HANDOFF_SCHEMA_MARKER) : -1;
  if (at < 0) return null;
  try {
    const schema = JSON.parse(goal.slice(at + HANDOFF_SCHEMA_MARKER.length));
    return schema && typeof schema === "object" && !Array.isArray(schema)
      ? schema
      : null;
  } catch {
    return null;
  }
}

// Codex validates outputSchema strictly (codex-rs core/src/client_common.rs:52):
// every property required, no open objects. Optional fields become nullable;
// a schema strict mode cannot express returns null (instruction-only handoff).
function strictOutputSchema(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (
    schema.type === "array" ||
    (Array.isArray(schema.type) && schema.type.includes("array"))
  ) {
    const items = strictOutputSchema(schema.items);
    return items === null ? null : { ...schema, items };
  }
  const isObject =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object"));
  if (!isObject) return { ...schema };
  if (schema.additionalProperties !== false || !schema.properties) return null;
  const required = new Set(schema.required || []);
  const properties = {};
  for (const [name, child] of Object.entries(schema.properties)) {
    const strict = strictOutputSchema(child);
    if (strict === null) return null;
    if (!required.has(name)) {
      const types = Array.isArray(strict.type) ? strict.type : [strict.type];
      strict.type = types.includes("null") ? types : [...types, "null"];
    }
    properties[name] = strict;
  }
  return { ...schema, properties, required: Object.keys(properties) };
}

// Drop the nulls strict mode forced onto optional, non-nullable fields so the
// handoff has the declared shape; return the file text, or null if not JSON.
function handoffFromFinalMessage(text, schema) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const prune = (node, nodeSchema) => {
    if (Array.isArray(node))
      return node.map((item) => prune(item, nodeSchema?.items));
    if (!node || typeof node !== "object" || !nodeSchema?.properties)
      return node;
    const required = new Set(nodeSchema.required || []);
    const out = {};
    for (const [key, item] of Object.entries(node)) {
      const child = nodeSchema.properties[key];
      const nullable =
        Array.isArray(child?.type) && child.type.includes("null");
      if (item === null && !required.has(key) && !nullable) continue;
      out[key] = prune(item, child);
    }
    return out;
  };
  return `${JSON.stringify(prune(value, schema), null, 2)}\n`;
}

/**
 * The service tier a session starts on. A requested tier the model does not
 * offer degrades to the next slower one it does (ultrafast → priority →
 * standard); with no request a new session keeps the fastest advertised tier.
 */
function supportedSpeed(requested, tiers, resumeId) {
  if (requested === "standard") return "standard";
  if (requested) {
    const order = ["ultrafast", "priority"];
    const start = Math.max(0, order.indexOf(requested));
    return (
      order.slice(start).find((tier) => tiers.includes(tier)) || "standard"
    );
  }
  if (resumeId) return null;
  return (
    ["ultrafast", "fast", "priority"].find((tier) => tiers.includes(tier)) ||
    "standard"
  );
}

function stageDirectAttachments(id, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > 20)
    throw new Error("invalid_attachments");
  const directory = join(
    home,
    "attachments",
    "direct",
    Buffer.from(id).toString("hex"),
  );
  const inputs = [];
  for (const [index, attachment] of attachments.entries()) {
    if (
      typeof attachment.base64_data !== "string" ||
      attachment.base64_data.length > 28_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        attachment.base64_data,
      )
    )
      throw new Error("invalid_attachment_data");
    const name = `${index}-${String(attachment.name || "attachment")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 120)}`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, name);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, Buffer.from(attachment.base64_data, "base64"), {
      mode: 0o600,
    });
    renameSync(temporary, path);
    inputs.push(
      String(attachment.mime_type || "").startsWith("image/")
        ? { type: "localImage", path }
        : { type: "text", text: `Attached file: ${path}`, text_elements: [] },
    );
  }
  return inputs;
}

function spawnCodexAppServer() {
  const legacyArgs = buildCodexArgs();
  // Keep the existing MCP/proxy overrides, replacing exec-only flags.
  const args = ["app-server", "--listen", "stdio://"];
  for (let i = 1; i < legacyArgs.length; i++) {
    if (legacyArgs[i] === "-c") args.push(legacyArgs[i], legacyArgs[++i]);
  }
  args.push(
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
  );
  const child = spawn("codex", args, {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: home,
      TERM: "xterm-256color",
    },
  });
  child.stderr.on("data", (data) => appendOutput("stderr", data.toString()));
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal })),
  );
  return { child, closed };
}

async function runCodexAppServer() {
  let { child, closed } = spawnCodexAppServer();
  const handoffSchema = handoffSchemaFromGoal(GOAL);
  const handoff = handoffSchema
    ? {
        schema: handoffSchema,
        write: (text) => {
          mkdirSync(dirname(CODE_AGENT_HANDOFF_PATH), { recursive: true });
          writeFileSync(CODE_AGENT_HANDOFF_PATH, text);
        },
      }
    : null;
  const settings = {
    model: usingApiKey ? CODEX_AZURE_MODEL : CODEX_MODEL,
    effort: process.env.CODEX_REASONING_EFFORT || null,
    speed: process.env.CODEX_SPEED || null,
  };
  nativeCodex = new CodexAppServer(child, appendEvent, settings, handoff);
  // Runtime fallback, as in the exec transport: a turn that failed because the
  // ChatGPT OAuth credential is unusable is re-sent ONCE on the same thread with
  // the funded Azure OpenAI provider (no ChatGPT proxy).
  let fallback = null;
  nativeCodex.recoverFailedTurn = (turn, error) => {
    const reason = classifyOAuthFallbackReason(error?.message || "");
    if (fallback || usingApiKey || !FUNDED_PROVIDER || !reason) return false;
    const failed = nativeCodex;
    const turnStart = failed.turnStarts.get(turn.id) ?? failed.pendingTurnStart;
    const threadId = failed.threadId;
    if (!turnStart || !threadId) return false;
    oauthFallbackReason = reason;
    fallback = (async () => {
      log("info", "Codex OAuth unavailable; retrying on the Azure provider", {
        reason,
      });
      appendOutput(
        "stdout",
        "[Codex] ChatGPT OAuth unavailable — retrying with funded OpenAI API key\n",
      );
      appendEvent({
        type: "auth_fallback",
        from: "chatgpt_oauth",
        to: "openai_api_key",
        funded_provider: "azure",
        reason,
      });
      failed.child.kill("SIGTERM");
      await closed;
      useFundedProvider();
      usingApiKey = true;
      oauthFallbackReason = null;
      const next = spawnCodexAppServer();
      const resumed = new CodexAppServer(
        next.child,
        appendEvent,
        // Azure honors only the priority tier; ultrafast there is silently standard.
        {
          ...failed.settings,
          model: CODEX_AZURE_MODEL,
          speed: failed.settings.speed === "standard" ? "standard" : "priority",
        },
        handoff,
      );
      nativeCodex = resumed;
      try {
        await resumed.resumeTurn(threadId, turnStart);
      } catch (error) {
        appendEvent({ type: "error", message: error.message });
        next.child.kill("SIGTERM");
      }
      return next.closed;
    })();
    return true;
  };
  try {
    nativeCodex.initialization = nativeCodex.initialize(
      CODEX_RESUME_SESSION_ID,
      sanitizedGoal,
    );
    await nativeCodex.initialization;
  } catch (error) {
    // A fallback that already took over the goal turn closes this process.
    if (!fallback) {
      appendEvent({ type: "error", message: error.message });
      child.kill("SIGTERM");
    }
  }
  let result = await closed;
  if (fallback) {
    // A failed fallback must still end the run with final/exit, never crash it.
    const retried = await fallback.catch((error) => {
      appendEvent({ type: "error", message: error.message });
      return null;
    });
    if (retried) result = await retried;
  }
  turnsClosed = true;
  exitCode = result.code;
  processExited = true;
  appendEvent({
    type: "final",
    status: result.code === 0 ? "completed" : "failed",
    exit_code: result.code,
    signal: result.signal,
  });
  broadcast("exit", result.code);
}

if (CODEX_TRANSPORT === "app-server") {
  await runCodexAppServer();
} else {
  // An API-key-only session (no OAuth credential) must skip the ChatGPT fast-mode
  // proxy — it targets the ChatGPT backend, which won't authenticate an API key.
  let { code, signal } = await runCodex(buildCodexArgs());

  // Runtime fallback: the ChatGPT OAuth token became unusable mid-run. Retry
  // ONCE on the funded Azure OpenAI provider (no ChatGPT proxy). Mirrors the
  // Rose compute-token→funded fallback.
  if (code !== 0 && !usingApiKey && FUNDED_PROVIDER && oauthFallbackReason) {
    const fallbackReason = oauthFallbackReason;
    log("info", "Codex OAuth unavailable; retrying on the Azure provider", {
      reason: fallbackReason,
    });
    appendOutput(
      "stdout",
      "[Codex] ChatGPT OAuth unavailable — retrying with funded OpenAI API key\n",
    );
    appendEvent({
      type: "auth_fallback",
      from: "chatgpt_oauth",
      to: "openai_api_key",
      funded_provider: "azure",
      reason: fallbackReason,
    });
    useFundedProvider();
    usingApiKey = true;
    oauthFallbackReason = null;
    ({ code, signal } = await runCodex(buildCodexArgs()));
  }

  // Delivered user turns run, in order, as resumed turns of the same thread.
  while (code === 0 && codexThreadId && queuedTurns.length > 0) {
    const turn = queuedTurns.shift();
    log("info", "Starting queued user turn", {
      id: turn.id,
      sender: turn.sender,
    });
    ({ code, signal } = await runCodex(
      buildCodexArgs({
        resume: { threadId: codexThreadId, text: turn.text },
      }),
    ));
  }
  turnsClosed = true;
  if (queuedTurns.length > 0) {
    appendEvent({
      type: "user_turn_undelivered",
      turn_ids: queuedTurns.map((turn) => turn.id),
    });
  }

  exitCode = code ?? 1;
  processExited = true;
  appendEvent({
    type: "final",
    status: exitCode === 0 ? "completed" : "failed",
    exit_code: exitCode,
    signal,
  });
  log("info", "Codex exited", { code: exitCode, signal });
  broadcast("exit", exitCode);
  log("info", "Serving final buffer for reattach until closed", {
    code: exitCode,
  });
}
