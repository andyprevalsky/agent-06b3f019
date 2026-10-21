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
const Native = vm.runInNewContext(block + "\nCodexAppServer", {
  log: () => {},
  workDir: "/work",
  codexUsageLimit: () => null,
});
function fixture() {
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
          data: [
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
          reasoningEffort: "high",
          serviceTier: null,
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
    native: new Native(child, (event) => events.push(event), {
      model: "model",
      effort: "high",
      speed: "standard",
    }),
    child,
    calls,
    events,
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
