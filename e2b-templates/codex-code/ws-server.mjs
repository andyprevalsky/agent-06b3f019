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
import { createHash, timingSafeEqual } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

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
// The backend sets CODEX_MODEL from the parent's tier; this fallback is the
// flash row of back-end/src/providers/codeAgentModels.ts (codex-code-model.case.ts).
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-6.1-sol";
// The speed the spawning agent asked for (standard | fast | ultrafast, from its
// Fast Mode button); catalogSpeed maps it onto the model's real tiers. Azure
// OpenAI has priority only: fast or ultrafast -> priority, standard -> none.
const CODEX_SPEED = process.env.CODEX_SPEED || "";
const CODEX_AZURE_SERVICE_TIER = "priority";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "";
// Codex model catalog for the funded provider (codexTemplate.ts
// CODEX_AZURE_MODEL_CATALOG_FILE), shipped next to this file. The CLI's bundled
// catalog has no gpt-6.1-sol, so without it Codex uses generic metadata that
// drops the priority tier and reasoning effort.
const CODEX_AZURE_MODEL_CATALOG = join(
  dirname(fileURLToPath(import.meta.url)),
  "azure-model-catalog.json",
);
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
// The first credential failure a typed Codex error classifies. Only an unusable
// login (oauth_refresh_invalid: revoked, refresh failed) switches the run to the
// funded Azure deployment in the sandbox (see the run-with-fallback block below).
// A usage limit or out of credits (usage_limit_reached) is reported as a
// structured usage_limit instead: the code-agent activity pauses the session and
// the parent's retry rotates own login -> shared pool -> Azure (C15), so the
// sandbox never starts an Azure continuation that the pause would throw away.
// The sandbox cannot lease another login itself (the backend leases credentials
// only at session create), so the backend arms the Azure switch only when no other
// subscription is leasable; otherwise the error carries `login_unusable` and the
// session pauses for the parent's retry (reportedLoginUnusable).
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
/**
 * The unusable login to report on a failed Codex turn, or null. An unusable
 * ChatGPT login (oauth_refresh_invalid: revoked, refresh failed) switches the run
 * to Azure only when the backend armed that switch (FUNDED_PROVIDER), which it
 * does only when no other subscription is leasable (subscriptions first, C15).
 * Without it the error carries `login_unusable`: the code-agent activity pauses
 * the session, the login is marked for reconnect and the parent's retry takes
 * the next credential. The first classification decides, as for usage limits.
 */
function reportedLoginUnusable(message) {
  if (FUNDED_PROVIDER || oauthFallbackReason !== "oauth_refresh_invalid")
    return null;
  return classifyOAuthFallbackReason(message || "") === "oauth_refresh_invalid"
    ? {
        reason: "oauth_refresh_invalid",
        ...(CREDENTIAL_FINGERPRINT
          ? { credential: CREDENTIAL_FINGERPRINT }
          : {}),
      }
    : null;
}
/**
 * Which leased login this sandbox holds, as a digest of its access token (never
 * the token): the backend marks a login for reconnect only when the stored
 * credential is still this one and has not simply expired (credentialFeedback.ts).
 */
const CREDENTIAL_FINGERPRINT = (() => {
  try {
    const token = JSON.parse(CODEX_AUTH_JSON || "null")?.tokens?.access_token;
    return typeof token === "string" && token
      ? createHash("sha256").update(token).digest("hex").slice(0, 16)
      : null;
  } catch {
    return null;
  }
})();
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

/**
 * The usage limit to report on a failed Codex turn, or null. A limit pauses the
 * session (C15), so none is reported while an unusable-login switch is pending.
 * Codex's own snapshot (rate limits, codexErrorInfo) wins; a typed error whose
 * complete message reports plan or credit exhaustion is a limit without a reset.
 * The ChatGPT snapshot is ignored once the funded Azure provider serves the run.
 */
function reportedUsageLimit(snapshot, error, message) {
  if (oauthFallbackReason === "oauth_refresh_invalid" && !usingApiKey)
    return null;
  if (snapshot && !usingApiKey) return snapshot;
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  if (
    info === "usageLimitExceeded" ||
    info === "usage_limit_exceeded" ||
    classifyOAuthFallbackReason(message) === "usage_limit_reached"
  ) {
    return { reached_type: null, resets_at: null };
  }
  return null;
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
wss.on("listening", () => {
  log("info", "Server listening", { port: wss.address().port });
});

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

// Each partial stream event carries the whole item so far. Once a newer
// snapshot or the completed item arrives, the stored copy keeps only its
// delta, so the replay buffer grows with the output, not its square.
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
    provider: "codex",
    timestamp: new Date().toISOString(),
    ...event,
    ...(typeof CODEX_TRANSPORT !== "undefined" &&
    CODEX_TRANSPORT === "app-server"
      ? { seq: eventBuffer.length + 1 }
      : {}),
  };
  supersedePartialSnapshot(normalized, eventBuffer.length);
  eventBuffer.push(normalized);
  broadcast("code_agent_event", normalized);
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
    const usageLimit = reportedUsageLimit(
      codexUsageLimit(),
      event.error,
      message,
    );
    const loginUnusable = reportedLoginUnusable(message);
    appendEvent({
      type: "error",
      raw_type: event.type,
      message,
      error: event.error || null,
      ...(usageLimit ? { usage_limit: usageLimit } : {}),
      ...(loginUnusable ? { login_unusable: loginUnusable } : {}),
    });
    return `[Codex] Turn failed: ${message}\n`;
  }
  if (event.type === "error") {
    const message =
      event.message || event.error?.message || JSON.stringify(event);
    oauthFallbackReason ??= classifyOAuthFallbackReason(message);
    const usageLimit = reportedUsageLimit(
      codexUsageLimit(),
      event.error,
      message,
    );
    const loginUnusable = reportedLoginUnusable(message);
    appendEvent({
      type: "error",
      raw_type: event.type,
      message,
      error: event.error || null,
      ...(usageLimit ? { usage_limit: usageLimit } : {}),
      ...(loginUnusable ? { login_unusable: loginUnusable } : {}),
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
  const params = new URL(req?.url || "/", "http://localhost").searchParams;
  if (replay && outputBuffer.length > 0) sendOutputReplay(ws);
  const cursor = Number(params.get("cursor") || 0);
  if (replay && eventBuffer.length > 0)
    sendEventReplay(
      ws,
      eventBuffer.filter((event) => !event.seq || event.seq > cursor),
      params.get("replay_chunks") === "1",
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

const home = homedir();
const codexHome = join(home, ".codex");
// Same contract as the Claude Code ws-server: ROSE_PROJECT_WORKDIR names an
// existing folder to work in (a restored project, or the folder a user granted
// to the Rose Mac app). That folder is never cloned into or given an AGENTS.md,
// and the session's scratch dirs stay under HOME.
const PROJECT_WORKDIR = process.env.ROSE_PROJECT_WORKDIR || "";
const projectMode = Boolean(PROJECT_WORKDIR) && existsSync(PROJECT_WORKDIR);
// Project sessions (backend restoreWorkspace): the checkout is already in
// ~/workspace with its env files; run the project's startup script before the
// CLI on every boot (create and resume) and tell the CLI how it went.
const PROJECT_STARTUP = process.env.ROSE_PROJECT_STARTUP || "";
const PROJECT_STARTUP_CONFIG = process.env.ROSE_PROJECT_STARTUP_CONFIG || "";
const PROJECT_NAME = process.env.ROSE_PROJECT_NAME || "";
const PROJECT_STARTUP_REPORT_PREFIX = "ROSE_PROJECT_STARTUP_REPORT ";
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
    host: azureHost(),
    service_tier: azureServiceTier(),
    effort: CODEX_REASONING_EFFORT || null,
    model_catalog: azureModelCatalogPath(),
  });
  return true;
}

/** Exec-transport default tier on Azure; app-server turns name theirs explicitly. */
function azureServiceTier() {
  return CODEX_SPEED === "fast" ||
    CODEX_SPEED === "priority" ||
    CODEX_SPEED === "ultrafast"
    ? CODEX_AZURE_SERVICE_TIER
    : null;
}

function azureHost() {
  try {
    return new URL(CODEX_AZURE_BASE_URL).host;
  } catch {
    return null;
  }
}

/** The shipped catalog when it describes the Azure deployment; otherwise the CLI's own. */
function azureModelCatalogPath() {
  try {
    const catalog = JSON.parse(readFileSync(CODEX_AZURE_MODEL_CATALOG, "utf8"));
    return (catalog.models || []).some((m) => m.slug === CODEX_AZURE_MODEL)
      ? CODEX_AZURE_MODEL_CATALOG
      : null;
  } catch {
    return null;
  }
}

/** Codex -c flags that select the Azure OpenAI funded provider. */
function fundedProviderArgs() {
  const catalog = azureModelCatalogPath();
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
    // Default tier for exec turns; app-server turns pass it explicitly.
    ...(azureServiceTier()
      ? ["-c", `service_tier=${JSON.stringify(azureServiceTier())}`]
      : []),
    ...(catalog ? ["-c", `model_catalog_json=${JSON.stringify(catalog)}`] : []),
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
      error: redactCredentials(err.message),
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
      `[Setup] Failed to clone repository: ${redactCredentials(err.message)}\n`,
    );
    log("error", "Failed to clone repository", {
      error: redactCredentials(err.message),
    });
  }
}

// A project's own AGENTS.md is never overwritten; the goal already carries the
// code-agent instructions.
if (!GITHUB_REPO_URL && !projectMode && CODE_AGENT_SYSTEM_PROMPT) {
  writeFileSync(join(workDir, "AGENTS.md"), CODE_AGENT_SYSTEM_PROMPT);
}

// Persistent code sessions work on their own branch (code-agent-persistent-
// sessions.md §1b); same contract as the Claude Code ws-server.
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

// A slow project startup (a cold dependency install) does not hold the agent:
// past the grace window it starts, told that startup is still running and
// where its report appears (same rule as the Claude ws-server, 2026-11-08).
const PROJECT_STARTUP_GRACE_MS = (() => {
  const raw = Number.parseInt(
    process.env.CODE_SESSION_PROJECT_STARTUP_GRACE_MS || "",
    10,
  );
  return Number.isInteger(raw) && raw >= 0 ? raw : 30_000;
})();
const projectStartup = runProjectStartup();
let projectStartupGrace = null;
const projectStartupReport = await Promise.race([
  projectStartup,
  new Promise((resolve) => {
    projectStartupGrace = setTimeout(() => {
      const { reportPath, logPath } = projectStartupPaths();
      log("info", "Project startup still running; starting the agent", {
        graceMs: PROJECT_STARTUP_GRACE_MS,
      });
      resolve({ status: "running", reportPath, logPath });
    }, PROJECT_STARTUP_GRACE_MS);
  }),
]).finally(() => clearTimeout(projectStartupGrace));

const sanitizedGoal = [
  CODE_AGENT_SYSTEM_PROMPT
    ? `System instructions:\n${CODE_AGENT_SYSTEM_PROMPT}`
    : "",
  `${projectStartupNote(projectStartupReport)}Task:\n${GOAL.replace(/\0/g, "")}`,
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
    // The tier's effort for exec turns; app-server turns name it explicitly.
    ...(CODEX_REASONING_EFFORT
      ? [
          "-c",
          `model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`,
        ]
      : []),
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
    } else if (message.method === "thread/goal/updated") {
      // The native thread goal's lifecycle: the monitor ends the attachment
      // only once no goal is active (an active goal starts continuation turns).
      this.emit({
        ...common,
        type: "goal",
        status: p.goal?.status || null,
        tokens_used: p.goal?.tokensUsed ?? null,
      });
    } else if (message.method === "thread/goal/cleared") {
      this.emit({ ...common, type: "goal", status: "cleared" });
    } else if (message.method === "thread/settings/updated") {
      const settings = p.threadSettings;
      this.settings = {
        model: settings.model,
        effort: settings.effort,
        speed: reportedSpeed(settings.serviceTier),
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
          usage_limit: null,
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
          usage_limit: this.usageLimit(
            p.turn.error,
            p.turn.error?.message || "Codex turn failed",
          ),
          ...this.loginUnusable(p.turn.error?.message || "Codex turn failed"),
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
        usage_limit: this.usageLimit(p.error, p.error?.message || p.message),
        ...this.loginUnusable(p.error?.message || p.message),
      });
  }
  usageLimit(error, message) {
    oauthFallbackReason ??= classifyOAuthFallbackReason(message || "");
    return reportedUsageLimit(this.rateLimitSnapshot(), error, message);
  }
  /** `login_unusable` for an error event (see reportedLoginUnusable); call after usageLimit. */
  loginUnusable(message) {
    const unusable = reportedLoginUnusable(message);
    return unusable ? { login_unusable: unusable } : {};
  }
  rateLimitSnapshot() {
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
  catalogModel(name) {
    return (
      this.models.find((m) => m.model === name || m.id === name) ||
      this.models.find((m) => m.isDefault)
    );
  }
  // Re-send a failed turn on a new app-server process (same thread, same input).
  async resumeTurn(threadId, turnStart) {
    await this.connect();
    // The new provider's catalog decides the tier: a ChatGPT-only tier
    // (ultrafast) carried over from the failed login becomes Azure's priority.
    const speed = catalogSpeed(
      this.catalogModel(this.settings.model),
      this.settings.speed,
    );
    const response = await this.request("thread/resume", {
      threadId,
      model: this.settings.model,
      serviceTier: speed === "standard" ? null : speed,
      cwd: workDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    this.threadId = response.thread.id;
    this.settings = {
      ...this.settings,
      model: response.model || this.settings.model,
      speed: reportedSpeed(response.serviceTier),
    };
    this.settingsVersion++;
    this.emit({
      type: "settings",
      thread_id: this.threadId,
      effective_settings: this.settings,
      reason: "auth_fallback",
    });
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
    const model = this.catalogModel(this.settings.model);
    const efforts = (model?.supportedReasoningEfforts || []).map(
      (e) => e.reasoningEffort,
    );
    this.settings = {
      ...this.settings,
      effort:
        this.settings.effort ??
        (!resumeId && efforts.includes("medium") ? "medium" : null),
      // The agent's request mapped onto this catalog (never "the fastest
      // tier by default"); no request is standard, or the saved tier on resume.
      speed: this.settings.speed
        ? catalogSpeed(model, this.settings.speed)
        : resumeId
          ? null
          : "standard",
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
      speed: reportedSpeed(response.serviceTier),
    };
    const goalTurnId = await this.start(
      [{ type: "text", text: goal, text_elements: [] }],
      this.settings,
      undefined,
      this.handoffSchema,
    );
    if (this.handoffSchema) this.handoffTurnId = goalTurnId;
    await this.setGoal(goal);
    this.ready = true;
    this.emit({
      type: "session",
      thread_id: this.threadId,
      status: "ready",
      effective_settings: this.settings,
    });
  }
  // Every code-agent task is also the thread's native goal (Andy, 2026-11-08):
  // Codex's app-server has no slash commands, so this is `/goal <task>` there.
  // Codex continues the thread until the model marks the goal complete.
  async setGoal(text) {
    const objective = goalObjective(text);
    if (!objective) return;
    try {
      await this.request("thread/goal/set", {
        threadId: this.threadId,
        objective,
        status: "active",
      });
    } catch (error) {
      log("warn", "Could not set the thread goal", { error: error.message });
      this.emit({ type: "goal", status: "unavailable", error: error.message });
    }
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
      // A new spawn's task delivered to this live session is its new goal.
      if (msg.sender === "agent" && typeof msg.text === "string")
        await this.setGoal(msg.text);
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
// The task's end condition names this file (service.py CODE_AGENT_HANDOFF_SCHEMA_PATH).
const CODE_AGENT_HANDOFF_SCHEMA_PATH = "/home/user/.rose/handoff.schema.json";
// codex-rs protocol MAX_THREAD_GOAL_OBJECTIVE_CHARS.
const GOAL_OBJECTIVE_MAX_CHARS = 4000;
// A task too long for the objective is written here and named by it.
const CODE_AGENT_TASK_PATH = "/home/user/.rose/task.md";

/**
 * The thread-goal objective for a worker task (null: not a code-agent task).
 * The result schema goes to its file; a task over the cap goes to a task file.
 */
function goalObjective(text) {
  const at =
    typeof text === "string" ? text.lastIndexOf(HANDOFF_SCHEMA_MARKER) : -1;
  if (at < 0) return null;
  const schema = text.slice(at + HANDOFF_SCHEMA_MARKER.length);
  // The task follows the last "Task:" header (system instructions and the
  // startup note lead the first turn).
  const head = text.slice(0, at);
  const taskAt = head.lastIndexOf("Task:\n");
  const task = taskAt >= 0 ? head.slice(taskAt + "Task:\n".length) : head;
  try {
    mkdirSync("/home/user/.rose", { recursive: true });
    writeFileSync(CODE_AGENT_HANDOFF_SCHEMA_PATH, schema);
  } catch (error) {
    log("warn", "Could not write the handoff schema", { error: error.message });
  }
  const objective = `Task:\n${task}`;
  if (objective.length <= GOAL_OBJECTIVE_MAX_CHARS) return objective;
  const taskPath = CODE_AGENT_TASK_PATH;
  try {
    writeFileSync(taskPath, task);
  } catch (error) {
    log("warn", "Could not write the task file", { error: error.message });
  }
  return `Task: read ${taskPath} and do exactly what it says. Its final paragraph is your end condition.`;
}

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

/** A funded Azure session keeps its deployment; only non-standard requests use priority. */
function azureSpeed(requested) {
  return requested && requested !== "standard" ? "priority" : "standard";
}

// A requested speed -> the catalog tiers that satisfy it, nearest first. Codex
// names priority processing "Fast"; ultrafast falls back to it when a model
// (gpt-6.1-terra, the Azure catalog) does not offer ultrafast.
const SPEED_TIERS = {
  ultrafast: ["ultrafast", "fast", "priority"],
  fast: ["priority", "fast"],
  priority: ["priority", "fast"],
};

/** Codex reports explicit standard routing as "default"; Rose calls it standard. */
function reportedSpeed(serviceTier) {
  return !serviceTier || serviceTier === "default" ? "standard" : serviceTier;
}

/** The tier this catalog model really offers for `requested`; standard when none. */
function catalogSpeed(model, requested) {
  const tiers = (model?.serviceTiers || []).map((t) => t.id);
  return (
    (SPEED_TIERS[requested] || []).find((tier) => tiers.includes(tier)) ||
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
    speed: usingApiKey
      ? azureSpeed(process.env.CODEX_SPEED || null)
      : process.env.CODEX_SPEED || null,
  };
  nativeCodex = new CodexAppServer(child, appendEvent, settings, handoff);
  // Runtime fallback, as in the exec transport: a turn that failed because the
  // ChatGPT OAuth credential is unusable is re-sent ONCE on the same thread with
  // the funded Azure OpenAI provider (no ChatGPT proxy).
  let fallback = null;
  nativeCodex.recoverFailedTurn = (turn, error) => {
    const reason = classifyOAuthFallbackReason(error?.message || "");
    // A usage limit pauses the session instead (C15); see oauthFallbackReason.
    if (fallback || usingApiKey || !FUNDED_PROVIDER) return false;
    if (reason !== "oauth_refresh_invalid") return false;
    if ((oauthFallbackReason ?? reason) !== "oauth_refresh_invalid")
      return false;
    const failed = nativeCodex;
    const turnStart = failed.turnStarts.get(turn.id) ?? failed.pendingTurnStart;
    const threadId = failed.threadId;
    if (!turnStart || !threadId) return false;
    oauthFallbackReason = reason;
    fallback = (async () => {
      log("info", "Codex OAuth unusable; continuing on the Azure provider", {
        reason,
      });
      appendOutput(
        "stdout",
        "[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n",
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
        {
          ...failed.settings,
          model: CODEX_AZURE_MODEL,
          speed: azureSpeed(failed.settings.speed),
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
  // Only an unusable login switches here; a usage limit already paused the run (C15).
  if (
    code !== 0 &&
    !usingApiKey &&
    FUNDED_PROVIDER &&
    oauthFallbackReason === "oauth_refresh_invalid"
  ) {
    const fallbackReason = oauthFallbackReason;
    log("info", "Codex OAuth unusable; continuing on the Azure provider", {
      reason: fallbackReason,
    });
    appendOutput(
      "stdout",
      "[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n",
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
