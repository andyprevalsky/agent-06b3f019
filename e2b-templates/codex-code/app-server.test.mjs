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
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const FIXTURE_ACCESS_TOKEN = "fixture-chatgpt-access-token";
const FIXTURE_ACCESS_FINGERPRINT = createHash("sha256")
  .update(FIXTURE_ACCESS_TOKEN)
  .digest("hex")
  .slice(0, 16);
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
function listeningPort(logs) {
  for (const line of logs.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.message === "Server listening") return entry.port;
    } catch {
      // A pipe chunk can end in the middle of a JSON log line.
    }
  }
  return 0;
}
const block = source.slice(
  source.indexOf("class CodexAppServer {"),
  source.indexOf("function stageDirectAttachments("),
);
// Files the thread-goal objective writes (schema, over-cap task), by path.
const goalFiles = new Map();
const sandbox = {
  log: () => {},
  workDir: "/work",
  codexUsageLimit: () => null,
  mkdirSync: () => {},
  writeFileSync: (path, data) => goalFiles.set(path, String(data)),
};
const {
  Native,
  strictOutputSchema,
  handoffFromFinalMessage,
  handoffSchemaFromGoal,
  setUsingApiKey,
  azureSpeed,
} = vm.runInNewContext(
  // The real credential-failure classifier and usage-limit reporter the class calls.
  "let oauthFallbackReason = null;\nlet usingApiKey = false;\nconst FUNDED_PROVIDER = false;\n" +
    source.slice(
      source.indexOf("function classifyOAuthFallbackReason("),
      source.indexOf("// C15: Codex's own rate-limit snapshot"),
    ) +
    source.slice(
      source.indexOf("function reportedUsageLimit("),
      source.indexOf("function codexUsageLimit() {"),
    ) +
    block +
    "\n({ Native: CodexAppServer, strictOutputSchema, handoffFromFinalMessage, handoffSchemaFromGoal, azureSpeed, setUsingApiKey: (value) => { usingApiKey = value; } })",
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
          model: request.params.model ?? "model",
          reasoningEffort:
            request.params.config?.model_reasoning_effort ?? "high",
          serviceTier: options.echoTier
            ? options.echoTier(request.params.serviceTier)
            : request.params.serviceTier,
        };
      if (request.method === "turn/start")
        result = { turn: { id: `turn-${++serial}` } };
      if (request.method === "turn/steer")
        result = { turnId: request.params.expectedTurnId };
      if (request.method === "thread/goal/set" && options.failGoal) {
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              id: request.id,
              error: { code: -32600, message: "goals feature is disabled" },
            }) + "\n",
          ),
        );
        return;
      }
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
// Speed is the spawning agent's request (CODEX_SPEED), never "the fastest
// tier by default". Each request takes the nearest tier the model really
// offers: ultrafast -> fast/priority, fast -> priority (Codex's "Fast").
test("new sessions select medium and map the requested speed onto the catalog", async () => {
  for (const [tiers, requested, expectedTier] of [
    [["priority", "ultrafast"], null, null],
    [["priority", "ultrafast"], "standard", null],
    [["priority", "ultrafast"], "ultrafast", "ultrafast"],
    [["priority", "ultrafast"], "fast", "priority"],
    [["priority"], "ultrafast", "priority"],
    [["fast"], "ultrafast", "fast"],
    [["fast"], "fast", "fast"],
    [[], "ultrafast", null],
  ]) {
    const { native, calls } = fixture({
      settings: { model: "model", effort: null, speed: requested },
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
    const why = `${JSON.stringify(tiers)} ${requested}`;
    const startup = calls.find((c) => c.method === "thread/start");
    assert.equal(startup.params.config.model_reasoning_effort, "medium");
    assert.equal(startup.params.serviceTier, expectedTier, why);
    assert.equal(calls.at(-1).params.effort, "medium");
    assert.equal(calls.at(-1).params.serviceTier, expectedTier, why);
    assert.equal(native.settings.speed, expectedTier || "standard", why);
  }
});
// Live 2026-10-28: Codex 0.159.0 answers a standard (null) request for
// gpt-6.1-sol with serviceTier "default", its explicit-standard sentinel.
test('Codex\'s explicit standard tier "default" reports as standard', async () => {
  const echoTier = (tier) => tier ?? "default";
  for (const resumeId of [null, "saved-thread"]) {
    const { native } = fixture({
      settings: { model: "model", effort: "high", speed: "standard" },
      echoTier,
    });
    await native.initialize(resumeId, "hello");
    assert.equal(native.settings.speed, "standard", String(resumeId));
  }
  const { native, events } = fixture({ echoTier });
  await native.initialize(null, "hello");
  native.receive({
    method: "thread/settings/updated",
    params: {
      threadId: "thread",
      threadSettings: {
        model: "model",
        effort: "high",
        serviceTier: "default",
      },
    },
  });
  assert.equal(native.settings.speed, "standard");
  assert.equal(events.at(-1).effective_settings.speed, "standard");
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
// Azure OpenAI sells priority processing only; fast and ultrafast are ChatGPT
// plan tiers. The funded provider's catalog advertises priority, so a Fast or
// Ultrafast agent gets priority there and a standard agent gets none.
test("the funded Azure provider maps fast and ultrafast to priority and standard to none", async () => {
  const azureModels = [
    {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
      ],
      serviceTiers: [{ id: "priority" }],
    },
  ];
  setUsingApiKey(true);
  try {
    for (const [resumeId, speed, expectedTier] of [
      [null, "ultrafast", "priority"],
      [null, "fast", "priority"],
      [null, "standard", null],
      [null, null, null],
      ["saved-thread", "ultrafast", "priority"],
      ["saved-thread", "standard", null],
    ]) {
      const { native, calls } = fixture({
        settings: { model: "gpt-6.1-sol", effort: "xhigh", speed },
        models: azureModels,
      });
      await native.initialize(resumeId, "hello");
      const why = `${resumeId} ${speed}`;
      const startup = calls.find((c) =>
        /^thread\/(start|resume)$/.test(c.method),
      );
      assert.equal(startup.params.serviceTier, expectedTier, why);
      assert.equal(startup.params.config.model_reasoning_effort, "xhigh", why);
      assert.equal(calls.at(-1).params.serviceTier, expectedTier, why);
      assert.equal(calls.at(-1).params.effort, "xhigh", why);
      assert.equal(native.settings.speed, expectedTier || "standard", why);
      await assert.rejects(
        native.deliver({ settings: { speed: "ultrafast" } }, []),
        /unsupported_speed/,
      );
    }
  } finally {
    setUsingApiKey(false);
  }
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
    const exitAnnounced=false,cliStdinOpen=true,taskPromptReady=Promise.resolve();
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
  let port = 0;
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  let ws;
  const sockets = [];
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        port = listeningPort(logs);
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
    await childClosed;
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

// Runs the real ws-server (app-server transport) over a fake Codex whose ChatGPT
// OAuth turns fail with `oauthError` and whose Azure-provider turns succeed.
// Returns the streamed events and the fake Codex's call journal.
async function runOAuthFailureFixture(
  oauthError,
  settled,
  {
    funded = true,
    oauth = true,
    model = "model",
    azureModel = "azure-terra",
    oauthTiers = [],
    speed = "",
    effort = "",
  } = {},
) {
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
 const flag=name=>{const at=process.argv.findIndex(a=>a.startsWith(name+'='));return at<0?null:JSON.parse(process.argv[at].slice(name.length+1));};
 const catalog=apiKey&&flag('model_catalog_json');
 const listed=catalog?JSON.parse(fs.readFileSync(catalog,'utf8')).models.map(e=>({id:e.slug,model:e.slug,supportedReasoningEfforts:[],serviceTiers:e.service_tiers})):[{id:process.env.CODEX_MODEL,model:process.env.CODEX_MODEL,supportedReasoningEfforts:[],serviceTiers:apiKey?[]:JSON.parse(process.env.FIXTURE_OAUTH_TIERS).map(id=>({id}))}];
 if(m.method==='model/list')result={data:listed};
 if(m.method==='thread/start'||m.method==='thread/resume'){note({method:m.method,threadId:m.params.threadId,model:m.params.model,serviceTier:m.params.serviceTier,effort:m.params.config?.model_reasoning_effort??null,defaultTier:apiKey?flag('service_tier'):null,defaultEffort:flag('model_reasoning_effort'),catalog,apiKey});result={thread:{id:'thread'},model:m.params.model,reasoningEffort:null,serviceTier:m.params.serviceTier??null};}
 if(m.method==='turn/start'){note({method:m.method,input:m.params.input,model:m.params.model,serviceTier:m.params.serviceTier,effort:m.params.effort??null,apiKey,auth:fs.existsSync(path.join(home,'auth.json'))});result={turn:{id:(apiKey?'key-':'oauth-')+(++turn)}};}
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
  let port = 0;
  const child = spawn(
    process.execPath,
    [new URL("./ws-server.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        HOME: directory,
        CODEX_AUTH_JSON: oauth
          ? JSON.stringify({
              auth_mode: "chatgpt",
              tokens: { access_token: FIXTURE_ACCESS_TOKEN },
            })
          : "",
        OPENAI_API_KEY: "",
        // Not armed (another subscription is leasable): no funded provider in the sandbox.
        AZURE_OPENAI_API_KEY: funded ? "azure-fixture-key" : "",
        CODEX_AZURE_BASE_URL: funded ? "https://azure.example/openai/v1" : "",
        CODEX_AZURE_MODEL: funded ? azureModel : "",
        CODEX_GOAL: "write the sentinel",
        CODEX_MODEL: model,
        FIXTURE_OAUTH_TIERS: JSON.stringify(oauthTiers),
        CODEX_SPEED: speed,
        CODEX_REASONING_EFFORT: effort,
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
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  let ws;
  const messages = [];
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        port = listeningPort(logs);
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
    assert.ok(
      settled(events()),
      `Codex fixture did not reach its expected outcome. Server output:\n${logs}`,
    );
    const calls = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    return { seen: events(), calls, logs };
  } finally {
    ws?.terminate();
    child.kill("SIGTERM");
    await childClosed;
    rmSync(directory, { recursive: true, force: true });
  }
}

// A server may exit before teardown begins. Preserve its assertion and logs
// instead of waiting forever for a close event that has already been emitted.
test("early server exit preserves the owning fallback failure and completes cleanup", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "rose-native-close-regression-"),
  );
  const preload = join(directory, "early-exit.cjs");
  writeFileSync(
    preload,
    `
const cp = require('node:child_process');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  if (args?.some(arg => String(arg).endsWith('/ws-server.mjs'))) {
    return original(command, ['-e', 'console.error("fixture early exit 23");process.exit(23)'], options);
  }
  return original(command, args, options);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        "--require",
        preload,
        "--test",
        "--test-name-pattern=^app-server switches to the funded Azure OpenAI provider when the ChatGPT login is unusable$",
        fileURLToPath(import.meta.url),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise((resolve) => child.once("close", resolve));
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const code = await closed;
    assert.equal(code, 1, output);
    assert.match(output, /failureType: 'testCodeFailure'/);
    assert.match(output, /fixture early exit 23/);
    assert.match(output, /# cancelled 0/);
    assert.doesNotMatch(
      output,
      /cancelledByParent|event loop has already resolved/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  const limits = seen
    .filter((e) => e.type === "error")
    .map((e) => e.usage_limit);
  assert.ok(limits.length > 0, "the usage-limit error is reported");
  assert.ok(
    limits.every(
      (limit) => limit?.reached_type === null && limit?.resets_at === null,
    ),
    `every error carries the structured limit the activity pauses on: ${JSON.stringify(limits)}`,
  );
  assert.equal(
    seen.some((e) => e.type === "auth_fallback"),
    false,
    "no in-sandbox switch",
  );
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
    {
      message:
        "Your access token could not be refreshed: refresh_token_invalidated",
    },
    (events) =>
      events.some((e) => e.type === "turn_ended" && e.status === "completed"),
  );
  assert.deepEqual(
    seen.filter((e) => e.type === "turn_ended").map((e) => e.status),
    ["completed"],
    `the OAuth failure must not end the run before the funded retry\n${logs}\n${JSON.stringify(seen)}`,
  );
  const oauthErrors = seen.filter(
    (e) =>
      e.type === "error" && /refresh_token_invalidated/.test(e.message ?? ""),
  );
  assert.ok(oauthErrors.length > 0, "the OAuth error is still reported");
  assert.ok(
    oauthErrors.every(
      (e) => e.usage_limit === null && e.login_unusable === undefined,
    ),
    "an unusable login with the switch armed is neither a usage limit nor a pause",
  );
  const fallback = seen.find((e) => e.type === "auth_fallback");
  assert.equal(fallback?.to, "openai_api_key");
  assert.equal(fallback?.funded_provider, "azure");
  assert.equal(
    fallback?.provider,
    "codex",
    "the envelope provider stays codex for the worker",
  );
  assert.equal(fallback?.reason, "oauth_refresh_invalid");
  assert.deepEqual(
    calls.map((c) => c.login ?? c.method),
    ["thread/start", "turn/start", "thread/resume", "turn/start"],
    "no codex login: the azure provider reads its key from the environment",
  );
  assert.equal(calls[0].apiKey, false, "user OAuth is tried first");
  assert.equal(
    calls[2].threadId,
    "thread",
    "the funded retry resumes the same thread",
  );
  assert.equal(
    calls[2].model,
    "azure-terra",
    "the retry runs on the Azure deployment",
  );
  assert.deepEqual(
    calls[3].input,
    calls[1].input,
    "the funded retry re-sends the same turn input",
  );
  assert.equal(calls[3].apiKey, true, "the retry selects the azure provider");
  assert.equal(
    calls[3].auth,
    false,
    "the ChatGPT auth.json is removed before the retry",
  );
});

// Subscriptions first (C15): with another subscription leasable the backend does
// not arm the Azure switch. The unusable login is reported as `login_unusable`
// (the activity pauses, the login is marked for reconnect, the parent retries on
// the next credential); nothing runs on Azure and nothing is a usage limit.
test("app-server reports an unusable login for the pause when no Azure switch is armed", async () => {
  const { seen, calls, logs } = await runOAuthFailureFixture(
    {
      message:
        "Your access token could not be refreshed: refresh_token_invalidated",
    },
    (events) => events.some((e) => e.type === "final"),
    { funded: false },
  );
  assert.deepEqual(
    seen.filter((e) => e.type === "turn_ended").map((e) => e.status),
    ["failed"],
    `the turn on the unusable login ends; the pause saves the session\n${logs}`,
  );
  const oauthErrors = seen.filter(
    (e) =>
      e.type === "error" && /refresh_token_invalidated/.test(e.message ?? ""),
  );
  assert.ok(oauthErrors.length > 0, "the OAuth error is reported");
  assert.ok(
    oauthErrors.every(
      (e) =>
        e.login_unusable?.reason === "oauth_refresh_invalid" &&
        // The held login as a fingerprint (the backend tells expired or
        // since-replaced from revoked by it), never the token itself.
        e.login_unusable?.credential === FIXTURE_ACCESS_FINGERPRINT &&
        !JSON.stringify(e).includes(FIXTURE_ACCESS_TOKEN) &&
        e.usage_limit === null,
    ),
    `every OAuth error carries login_unusable, never a usage limit: ${JSON.stringify(oauthErrors)}`,
  );
  assert.equal(
    seen.some((e) => e.type === "auth_fallback"),
    false,
    "no in-sandbox switch",
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/start", "turn/start"],
    "nothing runs on Azure",
  );
});

// GPT-6.1 Sol on both paths at the fastest tier each really offers: the
// ChatGPT catalog grants ultrafast; Azure sells priority only. Codex 0.159.0
// bundles no gpt-6.1-sol metadata, so the funded provider loads the shipped
// catalog (model_catalog_json) that advertises priority, and the login's
// ultrafast never reaches Azure after the switch.
test("the Azure switch continues GPT-6.1 Sol at priority, never the login's ultrafast", async () => {
  const { seen, calls, logs } = await runOAuthFailureFixture(
    {
      message:
        "Your access token could not be refreshed: refresh_token_invalidated",
    },
    (events) =>
      events.some((e) => e.type === "turn_ended" && e.status === "completed"),
    {
      model: "gpt-6.1-sol",
      azureModel: "gpt-6.1-sol",
      oauthTiers: ["priority", "ultrafast"],
      speed: "ultrafast",
      effort: "xhigh",
    },
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/start", "turn/start", "thread/resume", "turn/start"],
    `${logs}\n${JSON.stringify(seen)}`,
  );
  assert.equal(
    calls[0].serviceTier,
    "ultrafast",
    "the requested tier the ChatGPT catalog offers",
  );
  assert.equal(calls[0].effort, "xhigh");
  assert.equal(calls[2].model, "gpt-6.1-sol");
  assert.equal(calls[2].serviceTier, "priority", "Azure resumes at priority");
  assert.equal(
    calls[2].defaultTier,
    "priority",
    "exec turns default to priority too",
  );
  assert.match(String(calls[2].catalog), /azure-model-catalog\.json$/);
  assert.equal(calls[3].serviceTier, "priority");
  assert.equal(
    calls[3].effort,
    "xhigh",
    "the tier's effort passes through to Azure",
  );
  assert.equal(calls[2].defaultEffort, "xhigh");
  const settings = seen.filter((e) => e.type === "settings").at(-1);
  assert.deepEqual(
    {
      model: settings?.effective_settings?.model,
      speed: settings?.effective_settings?.speed,
    },
    { model: "gpt-6.1-sol", speed: "priority" },
    "the reported speed after the switch is Azure's",
  );
  assert.match(logs, /"host":"azure\.example".*"service_tier":"priority"/);
});

for (const [speed, expectedTier] of [
  ["fast", "priority"],
  ["priority", "priority"],
  ["ultrafast", "priority"],
  ["standard", null],
]) {
  test(`a ${speed} session funded by Azure alone starts GPT-6.1 Sol at ${expectedTier ?? "standard"}`, async () => {
    const { seen, calls, logs } = await runOAuthFailureFixture(
      {},
      // The fake turn can end before the server emits "ready" (after turn/start returns).
      (events) =>
        events.some(
          (e) => e.type === "turn_ended" && e.status === "completed",
        ) && events.some((e) => e.type === "session" && e.status === "ready"),
      {
        oauth: false,
        model: "gpt-6.1-sol",
        azureModel: "gpt-6.1-sol",
        speed,
        effort: "medium",
      },
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["thread/start", "turn/start"],
      logs,
    );
    assert.equal(calls[0].apiKey, true);
    assert.equal(calls[0].model, "gpt-6.1-sol");
    assert.equal(calls[0].serviceTier, expectedTier);
    assert.equal(
      calls[0].defaultTier,
      expectedTier,
      "exec default tier follows the request",
    );
    assert.equal(calls[0].effort, "medium");
    assert.equal(calls[1].serviceTier, expectedTier);
    const ready = seen.find(
      (e) => e.type === "session" && e.status === "ready",
    );
    assert.deepEqual(
      { ...ready?.effective_settings },
      {
        model: "gpt-6.1-sol",
        effort: "medium",
        speed: expectedTier ?? "standard",
      },
    );
  });
}
// Keep a real competing listener alive across the original native contract.
// A random candidate (or a probe released before spawn) is not port ownership.
test("native app-server contract owns its port while a candidate is occupied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rose-native-port-ownership-"));
  let competitor;
  let port;
  for (let candidate = 43000; candidate < 43100; candidate++) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(candidate, resolve);
      });
      competitor = server;
      port = candidate;
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  assert.ok(competitor, "must hold a real competing listener");
  const preload = join(directory, "occupied-candidate.cjs");
  writeFileSync(
    preload,
    `Math.random = () => ${(port - 43000 + 0.5) / 10000};\n`,
  );
  let child;
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    child = spawn(
      process.execPath,
      [
        "--require",
        preload,
        "--test",
        "--test-name-pattern=^production default app-server supports authenticated attachments, steer and cursor replay$",
        fileURLToPath(import.meta.url),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise((resolve) => child.once("close", resolve));
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    assert.equal(await closed, 0, output);
    assert.match(output, /# pass 1/);
    assert.doesNotMatch(output, /EADDRINUSE/);
    assert.equal(
      competitor.listening,
      true,
      "the foreign listener stays owned",
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await new Promise((resolve, reject) =>
      competitor.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

// S30 (2026-10-28): the query box's speed reaches Codex as its native service
// tier. Fast → priority ("Fast"), Ultrafast → ultrafast, Normal → standard. The
// explicitly selected model is preserved when its nearest supported tier is used.
const SPEED_CATALOG = [
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    serviceTiers: [{ id: "priority" }],
  },
  {
    id: "gpt-6.1-sol",
    model: "gpt-6.1-sol",
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    serviceTiers: [{ id: "priority" }, { id: "ultrafast" }],
  },
];
test("the requested query-box speed starts Codex on its native service tier", async () => {
  const cases = [
    { speed: "standard", model: "gpt-5.6-terra", tier: null },
    { speed: "priority", model: "gpt-5.6-terra", tier: "priority" },
    { speed: "ultrafast", model: "gpt-5.6-terra", tier: "priority" },
  ];
  for (const expected of cases) {
    const { native, calls } = fixture({
      settings: { model: "gpt-5.6-terra", effort: null, speed: expected.speed },
      models: SPEED_CATALOG,
    });
    await native.initialize(null, "hello");
    const startup = calls.find((c) => c.method === "thread/start");
    assert.equal(
      startup.params.model,
      expected.model,
      `${expected.speed}: model`,
    );
    assert.equal(
      startup.params.serviceTier,
      expected.tier,
      `${expected.speed}: tier`,
    );
    const turn = calls.find((c) => c.method === "turn/start");
    assert.equal(
      turn.params.serviceTier,
      expected.tier,
      `${expected.speed}: first turn tier`,
    );
  }
});
test("an unavailable requested tier degrades to the next slower tier, never faster", async () => {
  const onlyPriority = SPEED_CATALOG.slice(0, 1).map((m) => ({
    ...m,
    isDefault: true,
  }));
  const ultra = fixture({
    settings: { model: "gpt-5.6-terra", effort: null, speed: "ultrafast" },
    models: onlyPriority,
  });
  await ultra.native.initialize(null, "hello");
  assert.equal(
    ultra.calls.find((c) => c.method === "thread/start").params.serviceTier,
    "priority",
  );
  const noTiers = fixture({
    settings: { model: "model", effort: null, speed: "priority" },
    models: [{ id: "model", model: "model", serviceTiers: [] }],
  });
  await noTiers.native.initialize(null, "hello");
  assert.equal(
    noTiers.calls.find((c) => c.method === "thread/start").params.serviceTier,
    null,
  );
});
test("a funded Azure session keeps its deployment: ultrafast runs as priority, never a model switch", async () => {
  assert.equal(azureSpeed("standard"), "standard");
  assert.equal(azureSpeed("priority"), "priority");
  assert.equal(azureSpeed("ultrafast"), "priority");
  assert.equal(azureSpeed(null), "standard");
  const azureCatalog = [
    {
      id: "azure-terra",
      model: "azure-terra",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      serviceTiers: [{ id: "priority" }],
    },
    ...SPEED_CATALOG.slice(1),
  ];
  const { native, calls } = fixture({
    settings: {
      model: "azure-terra",
      effort: null,
      speed: azureSpeed("ultrafast"),
    },
    models: azureCatalog,
  });
  await native.initialize(null, "hello");
  const startup = calls.find((c) => c.method === "thread/start");
  assert.equal(startup.params.model, "azure-terra");
  assert.equal(startup.params.serviceTier, "priority");
});
test("Codex never routes through a Rose proxy or the demo cache", () => {
  for (const forbidden of [
    "chatgpt_base_url",
    "CODEX_FAST_MODE_PROXY_URL",
    "model_providers.fastmode",
    "codex-proxy",
    "fast_cache_proxy",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `ws-server must not contain ${forbidden}: Codex talks to its provider directly`,
    );
  }
});

// Every code-agent task is also the thread's native goal (Andy, 2026-11-08,
// root 0874662a): Codex keeps the thread going until the goal is complete, and
// the objective carries the task with its end condition (writing the handoff).
const HANDOFF_MARKER =
  "\n\nResult JSON Schema for /home/user/.rose/handoff.json:\n";
const GOAL_SCHEMA = '{"type":"object","required":["rose_handoff"]}';
test("a worker task sets the native thread goal after its first turn", async () => {
  goalFiles.clear();
  const { native, calls } = fixture();
  const task = "Remove the ring.\n\nEnd condition: write the handoff.";
  await native.initialize(
    null,
    `System instructions:\nbe good\n\nTask:\n${task}${HANDOFF_MARKER}${GOAL_SCHEMA}`,
  );
  const methods = calls.map((c) => c.method);
  assert.ok(
    methods.indexOf("thread/goal/set") > methods.indexOf("turn/start"),
    methods.join(","),
  );
  const goal = calls.find((c) => c.method === "thread/goal/set").params;
  assert.deepEqual(goal, {
    threadId: "thread",
    objective: `Task:\n${task}`,
    status: "active",
  });
  assert.equal(
    goalFiles.get("/home/user/.rose/handoff.schema.json"),
    GOAL_SCHEMA,
  );
});
test("a task over the objective cap goes to the task file the objective names", async () => {
  goalFiles.clear();
  const { native, calls } = fixture();
  const task = "y".repeat(5000);
  await native.initialize(
    null,
    `Task:\n${task}${HANDOFF_MARKER}${GOAL_SCHEMA}`,
  );
  const { objective } = calls.find(
    (c) => c.method === "thread/goal/set",
  ).params;
  assert.ok(objective.length <= 4000, String(objective.length));
  assert.match(objective, /\/home\/user\/\.rose\/task\.md/);
  assert.equal(goalFiles.get("/home/user/.rose/task.md"), task);
});
test("goal lifecycle is reported; an unavailable goal does not stop the run", async () => {
  const { native, events } = fixture({ failGoal: true });
  await native.initialize(null, `Task:\ndo it${HANDOFF_MARKER}${GOAL_SCHEMA}`);
  assert.equal(events.find((e) => e.type === "goal").status, "unavailable");
  native.receive({
    method: "thread/goal/updated",
    params: { threadId: "thread", goal: { status: "complete", tokensUsed: 9 } },
  });
  assert.equal(
    events.filter((e) => e.type === "goal").at(-1).status,
    "complete",
  );
  native.receive({
    method: "thread/goal/cleared",
    params: { threadId: "thread" },
  });
  assert.equal(
    events.filter((e) => e.type === "goal").at(-1).status,
    "cleared",
  );
});
test("a plain task without a result schema sets no goal", async () => {
  const { native, calls } = fixture();
  await native.initialize(null, "hello");
  assert.equal(
    calls.some((c) => c.method === "thread/goal/set"),
    false,
  );
});
