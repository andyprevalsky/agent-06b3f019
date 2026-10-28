import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
const require = createRequire(
  new URL("../../back-end/package.json", import.meta.url),
);
const { WebSocket } = require("ws");
const source = readFileSync(
  new URL("./ws-server.mjs", import.meta.url),
  "utf8",
);
const block = source.slice(
  source.indexOf("class CodexAppServer {"),
  source.indexOf("function stageDirectAttachments("),
);
const sandbox = {
  log: () => {},
  workDir: "/work",
  codexUsageLimit: () => null,
};
const {
  Native,
  strictOutputSchema,
  handoffFromFinalMessage,
  handoffSchemaFromGoal,
} = vm.runInNewContext(
  // The real credential-failure classifier and usage-limit reporter the class calls.
  "let oauthFallbackReason = null;\nlet usingApiKey = false;\n" +
    source.slice(
      source.indexOf("function classifyOAuthFallbackReason("),
      source.indexOf("// C15: Codex's own rate-limit snapshot"),
    ) +
    source.slice(
      source.indexOf("function reportedUsageLimit("),
      source.indexOf("function codexUsageLimit() {"),
    ) +
    block +
    "\n({ Native: CodexAppServer, strictOutputSchema, handoffFromFinalMessage, handoffSchemaFromGoal })",
  sandbox,
);
function fixture(options = {}) {
  const handoffWrites = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  const calls = [];
  let serial = 0;
  child.stdin = {
    write(line, callback) {
      const request = JSON.parse(line);
      calls.push(request);
      callback?.();
      if (request.id === undefined) return;
      let result = {};
      if (request.method === "model/list")
        result = {
          data: options.models || [
            {
              id: "model",
              model: "model",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              serviceTiers: [{ id: "fast" }],
            },
          ],
        };
      if (
        request.method === "thread/start" ||
        request.method === "thread/resume"
      )
        result = {
          thread: { id: "thread" },
          model: "model",
          reasoningEffort:
            request.params.config?.model_reasoning_effort ?? "high",
          serviceTier: request.params.serviceTier,
        };
      if (request.method === "turn/start")
        result = { turn: { id: `turn-${++serial}` } };
      if (request.method === "turn/steer")
        result = { turnId: request.params.expectedTurnId };
      queueMicrotask(() =>
        child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"),
      );
    },
  };
  const events = [];
  return {
    native: new Native(
      child,
      (event) => events.push(event),
      options.settings || {
        model: "model",
        effort: "high",
        speed: "standard",
      },
      options.handoffSchema
        ? {
            schema: options.handoffSchema,
            write: (text) => handoffWrites.push(text),
          }
        : null,
    ),
    child,
    calls,
    events,
    handoffWrites,
  };
}
test("native initialization, active steer and idle start preserve settings and turn identity", async () => {
  const { native, calls, events } = fixture();
  await native.initialize(null, "hello");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["initialize", "initialized", "model/list", "thread/start", "turn/start"],
  );
  const ack = await native.deliver({ id: "u1", settings: {} }, [
    { type: "text", text: "steer" },
  ]);
  assert.equal(ack.delivery_mode, "steer");
  assert.equal(ack.turn_id, "turn-1");
  assert.equal(calls.at(-1).params.expectedTurnId, "turn-1");
  native.receive({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed" } },
  });
  const idle = await native.deliver({ id: "u2", settings: { speed: "fast" } }, [
    { type: "localImage", path: "/image.png" },
  ]);
  assert.equal(idle.delivery_mode, "start");
  assert.equal(idle.turn_id, "turn-2");
  assert.equal(calls.at(-1).params.serviceTier, "fast");
  assert.equal(
    events.find((e) => e.type === "turn_ended").outcome,
    "completed",
  );
  assert.equal(
    calls.some((c) => /queue/.test(c.method)),
    false,
  );
});
test("new sessions select medium and fastest advertised tier before the first turn", async () => {
  for (const tiers of [["priority", "ultrafast"], ["fast"], ["priority"], []]) {
    const { native, calls } = fixture({
      settings: { model: "model", effort: null, speed: null },
      models: [
        {
          id: "model",
          model: "model",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
          serviceTiers: tiers.map((id) => ({ id })),
        },
      ],
    });
    await native.initialize(null, "hello");
    const expectedTier = tiers.includes("ultrafast")
      ? "ultrafast"
      : tiers.includes("fast")
        ? "fast"
        : tiers.includes("priority")
          ? "priority"
          : null;
    const startup = calls.find((c) => c.method === "thread/start");
    assert.equal(startup.params.config.model_reasoning_effort, "medium");
    assert.equal(startup.params.serviceTier, expectedTier);
    assert.equal(calls.at(-1).params.effort, "medium");
    assert.equal(calls.at(-1).params.serviceTier, expectedTier);
    assert.equal(native.settings.speed, expectedTier || "standard");
  }
});
test("startup preserves explicit settings and never invents unsupported effort", async () => {
  const explicit = fixture();
  await explicit.native.initialize(null, "hello");
  assert.equal(
    explicit.calls.find((c) => c.method === "thread/start").params.config
      .model_reasoning_effort,
    "high",
  );
  assert.equal(explicit.calls.at(-1).params.serviceTier, null);
  const unsupported = fixture({
    settings: { model: "model", effort: null, speed: null },
  });
  await unsupported.native.initialize(null, "hello");
  assert.equal(
    unsupported.calls.find((c) => c.method === "thread/start").params.config,
    undefined,
  );
});
test("resuming leaves saved native settings authoritative instead of replacing them with defaults", async () => {
  const { native, calls } = fixture({
    settings: { model: "model", effort: null, speed: null },
    models: [
      {
        id: "model",
        model: "model",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        serviceTiers: [{ id: "fast" }],
      },
    ],
  });
  await native.initialize("saved-thread", "continue");
  assert.equal(
    calls.find((c) => c.method === "thread/resume").params.config,
    undefined,
  );
  assert.equal(
    calls.find((c) => c.method === "thread/resume").params.serviceTier,
    null,
  );
  assert.equal(native.settings.effort, "high");
});
test("catalog rejects invented tiers, invalid effort and settings changes during a turn", async () => {
  const { native } = fixture();
  await native.initialize(null, "hello");
  await assert.rejects(
    native.deliver({ settings: { speed: "ultrafast" } }, []),
    /unsupported_speed/,
  );
  await assert.rejects(
    native.deliver({ settings: { effort: "unknown" } }, []),
    /unsupported_effort/,
  );
  await assert.rejects(
    native.deliver({ settings: { model: "unknown" } }, []),
    /unsupported_model/,
  );
  await assert.rejects(
    native.deliver({ settings: { speed: "fast" } }, []),
    /settings_change_requires_idle/,
  );
});
test("real notification deltas accumulate on stable rows and preserve lifecycle outcomes and tool kinds", async () => {
  const { native, events } = fixture();
  await native.initialize("resume-thread", "hello");
  native.receive({
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "turn-1" } },
  });
  for (const delta of ["Hel", "lo"])
    native.receive({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "turn-1",
        itemId: "message",
        delta,
      },
    });
  native.receive({
    method: "item/completed",
    params: {
      turnId: "turn-1",
      item: { id: "message", type: "agentMessage", text: "Hello" },
    },
  });
  native.receive({
    method: "item/started",
    params: {
      turnId: "turn-1",
      item: { id: "cmd", type: "commandExecution", command: "pwd" },
    },
  });
  native.receive({
    method: "turn/completed",
    params: { turn: { id: "turn-1", status: "interrupted" } },
  });
  const messages = events.filter((e) => e.type === "agent_message");
  assert.deepEqual(
    messages.map((e) => e.text),
    ["Hel", "Hello", "Hello"],
  );
  assert.ok(
    messages.every((e) => e.item_id === "message" && e.turn_id === "turn-1"),
  );
  assert.equal(events.find((e) => e.type === "command").tool_kind, "shell");
  assert.equal(events.at(-1).status, "interrupted");
});
test("native rejection leaves request retryable and transport death rejects pending RPC", async () => {
  const { native, child } = fixture();
  await native.initialize(null, "hello");
  child.stdin.write = () => {};
  const request = native.request("turn/steer", {});
  child.emit("close", 1);
  await assert.rejects(request, /app_server_closed/);
  assert.equal(native.ready, false);
});
test("native usage streams recorded session totals with active lifecycle and the original snapshot", async () => {
  const { native, events } = fixture();
  await native.initialize(null, "hello");
  native.receive({
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "turn-1" } },
  });
  const snapshot = {
    total: {
      inputTokens: 240,
      outputTokens: 70,
      cachedInputTokens: 120,
      reasoningOutputTokens: 15,
    },
    last: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 10 },
  };
  native.receive({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread", turnId: "turn-1", tokenUsage: snapshot },
  });
  const event = events.at(-1);
  assert.equal(event.type, "usage");
  assert.equal(event.usage_scope, "session");
  assert.equal(event.turn_id, "turn-1");
  assert.ok(Date.parse(event.turn_started_at));
  assert.equal(event.output_tokens, 70);
  assert.equal(event.input_tokens, 240);
  assert.equal(event.cached_input_tokens, 120);
  assert.equal(event.usage.output_tokens, 70);
  assert.equal(event.token_usage, snapshot);
  assert.equal(event.tokens_per_second, undefined);
  native.receive({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread",
      tokenUsage: { total: { outputTokens: 0, inputTokens: NaN } },
    },
  });
  const sparse = events.at(-1);
  assert.equal(sparse.output_tokens, 0);
  assert.equal("input_tokens" in sparse, false);
  assert.equal("cached_input_tokens" in sparse, false);
});
test("native account limits and authoritative settings survive lifecycle normalization", async () => {
  const { native, events } = fixture();
  await native.initialize(null, "hello");
  native.receive({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        primary: { usedPercent: 100, resetsAt: 1800000000 },
        rateLimitReachedType: "primary",
      },
    },
  });
  native.receive({
    method: "thread/settings/updated",
    params: {
      threadId: "thread",
      threadSettings: { model: "model", effort: "high", serviceTier: "fast" },
    },
  });
  assert.equal(native.settings.speed, "fast");
  native.receive({
    method: "turn/completed",
    params: {
      turn: { id: "turn-1", status: "failed", error: { message: "limit" } },
    },
  });
  const error = events.find((event) => event.type === "error");
  assert.equal(error.usage_limit.resets_at, 1800000000);
  assert.equal(error.usage_limit.reached_type, "primary");
  assert.equal(events.at(-1).status, "failed");
});
test("Claude stdin failure never records delivery, holds the session or poisons dedupe", async () => {
  const claudeSource = readFileSync(
    new URL("../claude-code/ws-server.mjs", import.meta.url),
    "utf8",
  );
  const deliver = claudeSource.slice(
    claudeSource.indexOf("async function deliverNativeTurn(msg)"),
    claudeSource.indexOf("function handleHandBack(msg)"),
  );
  const result = await vm.runInNewContext(`(async()=>{
    let activeTurn=null,pendingTurns=0,directHold=false;
    const deliveredTurnIds=new Map(),events=[];
    const tokenMatches=()=>true,turnAck=(id,status,reason)=>({id,status,reason});
    const MAX_TURN_ID_CHARS=128,MAX_TURN_TEXT_CHARS=100000;
    const exitAnnounced=false,cliStdinOpen=true;
    const cliChild={stdin:{write(line,callback){callback(new Error("EPIPE"));}}};
    const applyTurnSettings=async()=>{},stageTurnAttachments=()=>[],userMessageLine=text=>text;
    const startNativeTurn=()=>activeTurn={id:"failed-start"};
    const endNativeTurn=()=>{activeTurn=null;};
    const appendEvent=event=>events.push(event),appendOutput=()=>{},clearDirectHoldTimer=()=>{},log=()=>{};
    const effectiveSettings={model:"test",speed:"standard"};
    ${deliver}
    const ack=await deliverNativeTurn({id:"retryable-message",token:"ok",text:"hello",sender:"user"});
    return JSON.stringify({ack,pendingTurns,directHold,dedupe:deliveredTurnIds.size,events});
  })()`);
  const outcome = JSON.parse(result);
  assert.equal(outcome.ack.status, "rejected");
  assert.equal(outcome.pendingTurns, 0);
  assert.equal(outcome.directHold, false);
  assert.equal(outcome.dedupe, 0);
  assert.equal(outcome.events.length, 0);
});
// Exercise the production-default ws entrypoint with only the CLI process IO
// replaced; this catches staging, authentication, replay and ack wiring.
test("production default app-server supports authenticated attachments, steer and cursor replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rose-native-codex-"));
  const fixturePath = join(directory, "codex");
  writeFileSync(
    fixturePath,
    `#!/usr/bin/env node
const readline=require('node:readline');
let turn=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='model/list')result={data:[{id:'model',model:'model',supportedReasoningEfforts:[],serviceTiers:[]}]};
 if(m.method==='thread/start')result={thread:{id:'thread'},model:'model',reasoningEffort:null,serviceTier:null};
 if(m.method==='turn/start')result={turn:{id:'turn-'+(++turn)}};
 if(m.method==='turn/steer'){result={turnId:m.params.expectedTurnId};const image=m.params.input.find(i=>i.type==='localImage');if(image&&!require('node:fs').existsSync(image.path))throw Error('attachment missing');}
 send({id:m.id,result});
 if(m.method==='turn/start'){send({method:'turn/started',params:{threadId:'thread',turn:{id:result.turn.id}}});send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:result.turn.id,itemId:'answer',delta:'Hello'}});}
});
`,
  );
  chmodSync(fixturePath, 0o755);
  const port = 43000 + Math.floor(Math.random() * 10000);
  const child = spawn(
    process.execPath,
    [new URL("./ws-server.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        HOME: directory,
        CODEX_AUTH_JSON: "{}",
        OPENAI_API_KEY: "",
        CODEX_GOAL: "test",
        CODEX_MODEL: "model",
        CODE_SESSION_TURN_TOKEN: "native-token",
        PORT: String(port),
        GITHUB_REPO_URL: "",
        ROSE_PROJECT_WORKDIR: "",
        CODEX_FAST_MODE_PROXY_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  let ws;
  const sockets = [];
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        sockets.push(ws);
        await new Promise((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(ws.readyState, 1, logs);
    const messages = [];
    ws.on("message", (d) => messages.push(JSON.parse(d)));
    const wait = async (predicate) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(logs + "\n" + JSON.stringify(messages));
    };
    await wait(
      () =>
        messages.some((m) =>
          (m.data || []).some?.(
            (e) => e.type === "session" && e.status === "ready",
          ),
        ) ||
        messages.some(
          (m) =>
            m.type === "code_agent_event" &&
            m.data.type === "session" &&
            m.data.status === "ready",
        ),
    );
    ws.send(
      JSON.stringify({
        type: "user_turn",
        id: "unauth",
        token: "bad",
        text: "hi",
      }),
    );
    await wait(() =>
      messages.some((m) => m.type === "user_turn_ack" && m.id === "unauth"),
    );
    assert.equal(
      messages.find((m) => m.id === "unauth").reason,
      "unauthorized",
    );
    ws.send(
      JSON.stringify({ type: "session_capabilities", token: "native-token" }),
    );
    await wait(() =>
      messages.some((m) => m.type === "session_capabilities_ack"),
    );
    assert.equal(
      messages.find((m) => m.type === "session_capabilities_ack").status,
      "delivered",
    );
    assert.equal(
      messages.find((m) => m.type === "session_capabilities_ack").models[0]
        .model,
      "model",
    );
    const sendTurn = {
      type: "user_turn",
      id: "attachment/../request",
      token: "native-token",
      text: "see attached",
      attachments: [
        {
          name: "../../image.png",
          mime_type: "image/png",
          base64_data: Buffer.from("image fixture").toString("base64"),
        },
      ],
    };
    ws.send(JSON.stringify(sendTurn));
    await wait(() =>
      messages.some((m) => m.type === "user_turn_ack" && m.id === sendTurn.id),
    );
    const ack = messages.find(
      (m) => m.type === "user_turn_ack" && m.id === sendTurn.id,
    );
    assert.equal(ack.status, "delivered");
    assert.equal(ack.delivery_mode, "steer");
    assert.equal(ack.turn_id, "turn-1");
    assert.equal(
      existsSync(
        join(
          directory,
          "attachments",
          "direct",
          Buffer.from(sendTurn.id).toString("hex"),
          "0-.._.._image.png",
        ),
      ),
      true,
    );
    ws.send(JSON.stringify(sendTurn));
    await wait(
      () =>
        messages.filter(
          (m) => m.type === "user_turn_ack" && m.id === sendTurn.id,
        ).length === 2,
    );
    assert.equal(
      messages.filter(
        (m) => m.type === "user_turn_ack" && m.id === sendTurn.id,
      )[1].status,
      "duplicate",
    );
    const events = messages.flatMap((m) =>
      m.type === "code_agent_event"
        ? [m.data]
        : m.type === "code_agent_events"
          ? m.data
          : [],
    );
    const latest = events.at(-1).seq;
    const replay = new WebSocket(`ws://127.0.0.1:${port}?cursor=${latest - 1}`);
    sockets.push(replay);
    const replayMessages = [];
    replay.on("message", (d) => replayMessages.push(JSON.parse(d)));
    await wait(() =>
      replayMessages.some((m) => m.type === "code_agent_events"),
    );
    const remaining = replayMessages.find(
      (m) => m.type === "code_agent_events",
    ).data;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].seq, latest);
    assert.equal(remaining[0].client_message_id, sendTurn.id);
  } finally {
    for (const socket of sockets) socket.terminate();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

// R3c: Codex completed its turn and replied without writing the instruction-only
// handoff file. Port `codex exec --output-schema` + `--output-last-message`
// (codex-rs exec/src/event_processor.rs:33-42): the first turn carries the
// handoff schema as turn/start outputSchema and its final message becomes the file.
// Helpers run in the VM realm; compare their values as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));
const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    sentinel: { type: "string", description: "The file text." },
    note: { type: "string" },
  },
  required: ["sentinel"],
  additionalProperties: false,
};

test("handoff schema rides the goal's first turn as a strict outputSchema", async () => {
  const goal = `Do it.\n\nResult JSON Schema for /home/user/.rose/handoff.json:\n${JSON.stringify(HANDOFF_SCHEMA)}`;
  assert.deepEqual(plain(handoffSchemaFromGoal(goal)), HANDOFF_SCHEMA);
  assert.equal(handoffSchemaFromGoal("Do it."), null);
  const { native, calls } = fixture({ handoffSchema: HANDOFF_SCHEMA });
  await native.initialize(null, goal);
  const turns = calls.filter((c) => c.method === "turn/start");
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].params.outputSchema,
    plain(strictOutputSchema(HANDOFF_SCHEMA)),
  );
  assert.deepEqual(turns[0].params.outputSchema.required, ["sentinel", "note"]);
  assert.deepEqual(turns[0].params.outputSchema.properties.note.type, [
    "string",
    "null",
  ]);
  // A later user turn is ordinary conversation, not the handoff.
  await native.start(
    [{ type: "text", text: "more", text_elements: [] }],
    native.settings,
  );
  assert.equal(
    calls.filter((c) => c.method === "turn/start")[1].params.outputSchema,
    undefined,
  );
});

test("the handoff turn's final message is written as the handoff file", async () => {
  const { native, child, handoffWrites } = fixture({
    handoffSchema: HANDOFF_SCHEMA,
  });
  await native.initialize(null, "goal");
  const send = (method, params) =>
    child.stdout.write(JSON.stringify({ method, params }) + "\n");
  send("item/completed", {
    threadId: "thread",
    turnId: "turn-1",
    item: {
      type: "agentMessage",
      id: "a",
      text: '{"sentinel":"OK","note":null}',
    },
  });
  send("turn/completed", {
    threadId: "thread",
    turn: { id: "turn-1", status: "completed" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  // Strict-mode nulls for optional fields are dropped: the file has the declared shape.
  assert.deepEqual(plain(handoffWrites), ['{\n  "sentinel": "OK"\n}\n']);
});

test("open-object schemas cannot be strict: no outputSchema, no written handoff", async () => {
  const open = {
    type: "object",
    properties: { data: { type: "object", additionalProperties: true } },
    required: ["data"],
    additionalProperties: false,
  };
  assert.equal(strictOutputSchema(open), null);
  const { native, calls, child, handoffWrites } = fixture({
    handoffSchema: open,
  });
  await native.initialize(null, "goal");
  assert.equal(
    calls.find((c) => c.method === "turn/start").params.outputSchema,
    undefined,
  );
  child.stdout.write(
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "turn-1", status: "completed" },
      },
    }) + "\n",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plain(handoffWrites), []);
  assert.equal(handoffFromFinalMessage("not json", HANDOFF_SCHEMA), null);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Runs the real ws-server (app-server transport) over a fake Codex whose ChatGPT
// OAuth turns fail with `oauthError` and whose Azure-provider turns succeed.
// Returns the streamed events and the fake Codex's call journal.
async function runOAuthFailureFixture(oauthError, settled) {
  const directory = mkdtempSync(join(tmpdir(), "rose-native-codex-fallback-"));
  const fixturePath = join(directory, "codex");
  const journal = join(directory, "journal.jsonl");
  writeFileSync(
    fixturePath,
    `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const home=process.env.CODEX_HOME;
const note=x=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(x)+'\\n');
if(process.argv[2]==='login'){note({login:true});process.exit(1);}
const argv=process.argv.join(' ');
const apiKey=argv.includes('model_provider="azure"')&&argv.includes('model_providers.azure.base_url="https://azure.example/openai/v1"')&&argv.includes('model_providers.azure.env_key="AZURE_OPENAI_API_KEY"')&&process.env.AZURE_OPENAI_API_KEY==='azure-fixture-key';
const readline=require('node:readline');let turn=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='model/list')result={data:[{id:'model',model:'model',supportedReasoningEfforts:[],serviceTiers:[]}]};
 if(m.method==='thread/start'||m.method==='thread/resume'){note({method:m.method,threadId:m.params.threadId,model:m.params.model,apiKey});result={thread:{id:'thread'},model:'model',reasoningEffort:null,serviceTier:null};}
 if(m.method==='turn/start'){note({method:m.method,input:m.params.input,model:m.params.model,apiKey,auth:fs.existsSync(path.join(home,'auth.json'))});result={turn:{id:(apiKey?'key-':'oauth-')+(++turn)}};}
 send({id:m.id,result});
 if(m.method!=='turn/start')return;
 const id=result.turn.id;send({method:'turn/started',params:{threadId:'thread',turn:{id}}});
 if(!apiKey){const error=JSON.parse(process.env.FIXTURE_OAUTH_ERROR);
  send({method:'error',params:{threadId:'thread',turnId:id,error}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id,status:'failed',error}}});return;}
 send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:id,itemId:'answer',delta:'CODEX_E2B_OK'}});
 send({method:'turn/completed',params:{threadId:'thread',turn:{id,status:'completed'}}});
});
`,
  );
  chmodSync(fixturePath, 0o755);
  // A port the OS just handed out: a random pick can collide with a live listener.
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [new URL("./ws-server.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        HOME: directory,
        CODEX_AUTH_JSON: JSON.stringify({ auth_mode: "chatgpt", tokens: {} }),
        OPENAI_API_KEY: "",
        AZURE_OPENAI_API_KEY: "azure-fixture-key",
        CODEX_AZURE_BASE_URL: "https://azure.example/openai/v1",
        CODEX_AZURE_MODEL: "azure-terra",
        CODEX_GOAL: "write the sentinel",
        CODEX_MODEL: "model",
        CODE_SESSION_TURN_TOKEN: "native-token",
        PORT: String(port),
        GITHUB_REPO_URL: "",
        ROSE_PROJECT_WORKDIR: "",
        CODEX_FAST_MODE_PROXY_URL: "",
        FIXTURE_OAUTH_ERROR: JSON.stringify(oauthError),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Registered at spawn: an early exit (e.g. a failed listen) must not hang cleanup.
  const closed = new Promise((resolve) => child.once("close", resolve));
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  let ws;
  const messages = [];
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}?cursor=0`);
        // Replayed events can arrive with the upgrade; listen before awaiting open.
        ws.on("message", (d) => messages.push(JSON.parse(d)));
        await new Promise((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const events = () =>
      messages.flatMap((m) =>
        m.type === "code_agent_event"
          ? [m.data]
          : m.type === "code_agent_events"
            ? m.data
            : [],
      );
    for (let i = 0; i < 500; i++) {
      if (settled(events())) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const calls = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    return { seen: events(), calls, logs };
  } finally {
    ws?.terminate();
    child.kill("SIGTERM");
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
}

// C15 (2026-10-28): a usage limit or out of credits pauses the session; the
// parent's retry rotates own login -> shared pool -> Azure. The sandbox reports
// the structured limit and must not start an Azure continuation the pause would
// throw away (the earlier in-sandbox switch also skipped the shared pool).
test("app-server reports a ChatGPT usage limit for the pause and does not switch to Azure in the sandbox", async () => {
  const { seen, calls, logs } = await runOAuthFailureFixture(
    {
      message:
        "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 2nd, 2026 7:25 AM.",
      codexErrorInfo: "usageLimitExceeded",
    },
    (events) => events.some((e) => e.type === "final"),
  );
  assert.deepEqual(
    seen.filter((e) => e.type === "turn_ended").map((e) => e.status),
    ["failed"],
    `the limited turn ends; the pause saves the session\n${logs}`,
  );
  const limits = seen.filter((e) => e.type === "error").map((e) => e.usage_limit);
  assert.ok(limits.length > 0, "the usage-limit error is reported");
  assert.ok(
    limits.every((limit) => limit?.reached_type === null && limit?.resets_at === null),
    `every error carries the structured limit the activity pauses on: ${JSON.stringify(limits)}`,
  );
  assert.equal(seen.some((e) => e.type === "auth_fallback"), false, "no in-sandbox switch");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/start", "turn/start"],
    "nothing runs on Azure: the parent's retry rotates the credential",
  );
});

// An unusable login (revoked / refresh failed) is not a pause: report the OAuth
// error, switch Codex to the azure provider (no login; the key is read from
// AZURE_OPENAI_API_KEY) and resume the thread with the same turn input on the
// Azure deployment. The sandbox cannot lease a shared pool login (the backend
// leases credentials only at session create), so this switch goes to Azure.
test("app-server switches to the funded Azure OpenAI provider when the ChatGPT login is unusable", async () => {
  const { seen, calls, logs } = await runOAuthFailureFixture(
    { message: "Your access token could not be refreshed: refresh_token_invalidated" },
    (events) => events.some((e) => e.type === "turn_ended" && e.status === "completed"),
  );
  assert.deepEqual(
    seen.filter((e) => e.type === "turn_ended").map((e) => e.status),
    ["completed"],
    `the OAuth failure must not end the run before the funded retry\n${logs}\n${JSON.stringify(seen)}`,
  );
  const oauthErrors = seen.filter((e) => e.type === "error" && /refresh_token_invalidated/.test(e.message ?? ""));
  assert.ok(oauthErrors.length > 0, "the OAuth error is still reported");
  assert.ok(
    oauthErrors.every((e) => e.usage_limit === null),
    "an unusable login is not a usage limit: nothing pauses",
  );
  const fallback = seen.find((e) => e.type === "auth_fallback");
  assert.equal(fallback?.to, "openai_api_key");
  assert.equal(fallback?.funded_provider, "azure");
  assert.equal(fallback?.provider, "codex", "the envelope provider stays codex for the worker");
  assert.equal(fallback?.reason, "oauth_refresh_invalid");
  assert.deepEqual(
    calls.map((c) => c.login ?? c.method),
    ["thread/start", "turn/start", "thread/resume", "turn/start"],
    "no codex login: the azure provider reads its key from the environment",
  );
  assert.equal(calls[0].apiKey, false, "user OAuth is tried first");
  assert.equal(calls[2].threadId, "thread", "the funded retry resumes the same thread");
  assert.equal(calls[2].model, "azure-terra", "the retry runs on the Azure deployment");
  assert.deepEqual(calls[3].input, calls[1].input, "the funded retry re-sends the same turn input");
  assert.equal(calls[3].apiKey, true, "the retry selects the azure provider");
  assert.equal(calls[3].auth, false, "the ChatGPT auth.json is removed before the retry");
});
