import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const serverPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "ws-server.mjs",
);
const fake = String.raw`
const {createInterface}=require('node:readline');
const {existsSync,writeFileSync}=require('node:fs');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let active=false,turn=0,body='',settings={model:'test-model',effort:'high',speed:'standard'};
function piece(text) {body+=text;send({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});}
createInterface({input:process.stdin}).on('line',line=>{
const msg=JSON.parse(line);
if(msg.type==='control_request') {
 let response={};let subtype='success';
 // A cold CLI answers initialize only after its own startup finishes.
 if(msg.request.subtype==='initialize'&&process.env.INIT_DELAY_MS){setTimeout(()=>send({type:'control_response',response:{request_id:msg.request_id,subtype,response:{models:[{value:'test-model',displayName:'Native test model',supportedEffortLevels:['low','medium','high'],supportsFastMode:true}]}}}),Number(process.env.INIT_DELAY_MS));return;}
 if(msg.request.subtype==='initialize') response={models:[{value:'test-model',displayName:'Native test model',supportedEffortLevels:['low','medium','high'],supportsFastMode:true}]};
 else if(msg.request.subtype==='apply_flag_settings') Object.assign(settings,msg.request.settings);
 else if(msg.request.subtype==='set_model') settings.model=msg.request.model;
 else subtype='error';
 send({type:'control_response',response:{request_id:msg.request_id,subtype,response}});return;
}
if(msg.type!=='user')return;
if(!active){if(turn===0)writeFileSync(process.env.SETTINGS_FILE,JSON.stringify(settings));active=true;turn++;body='';send({type:'stream_event',event:{type:'message_start',message:{id:'msg-'+turn,usage:{input_tokens:11,output_tokens:1}}}});send({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});}
piece(msg.message.content.map(p=>p.text||'').join(''));
if(turn===1) {
 const tick=setInterval(()=>{if(existsSync(process.env.RELEASE_FILE)){clearInterval(tick);finish();}},10);
 tick.unref();
} else finish();
});
function finish(){if(!active)return;active=false;send({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:5}}});send({type:'assistant',message:{id:'msg-'+turn,content:[{type:'text',text:body}]}});send({type:'result',subtype:'success',result:body,queued_turn_count:0});}
`;
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  return ws;
}
async function rpc(url, payload) {
  const ws = await connect(url + "?replay=0");
  try {
    return await new Promise((r, j) => {
      const timer = setTimeout(() => j(new Error("ack timeout")), 8000);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (
          m.type === "user_turn_ack" ||
          m.type === "session_capabilities_ack"
        ) {
          clearTimeout(timer);
          r(m);
        }
      });
      ws.send(JSON.stringify(payload));
    });
  } finally {
    ws.close();
  }
}
async function until(predicate) {
  for (let i = 0; i < 600; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("event timeout");
}
// Fast mode is the spawning agent's request (CLAUDE_CODE_SPEED), never a
// default: no request is standard even when the catalog supports fast.
for (const profile of [
  { name: "defaults", env: {}, effort: "medium", fast: false },
  {
    name: "fast request",
    env: { CLAUDE_CODE_SPEED: "fast" },
    effort: "medium",
    fast: true,
  },
  {
    name: "explicit overrides",
    env: {
      CLAUDE_CODE_EFFORT: "low",
      CLAUDE_CODE_SPEED: "standard",
      CLAUDE_CODE_FAST_MODE: "0",
    },
    effort: "low",
    fast: false,
  },
])
  test(`Claude native ${profile.name}, steering, controls, attachments, lifecycle and durable replay`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rose-c18-claude-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "home"));
    writeFileSync(join(dir, "fake.cjs"), fake);
    writeFileSync(
      join(dir, "bin", "claude"),
      `#!/bin/sh\nexec '${process.execPath}' '${join(dir, "fake.cjs")}'\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [serverPath], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: join(dir, "bin") + ":" + process.env.PATH,
        HOME: join(dir, "home"),
        PORT: "0",
        CLAUDE_CODE_GOAL: "initial",
        CLAUDE_CODE_MODEL: "test-model",
        ANTHROPIC_API_KEY: "fake",
        CODE_SESSION_TURN_TOKEN: "test-token",
        RELEASE_FILE: join(dir, "release"),
        SETTINGS_FILE: join(dir, "startup-settings.json"),
        CLAUDE_CODE_FAST_MODE: "",
        CLAUDE_CODE_EFFORT: "",
        CLAUDE_CODE_SPEED: "",
        ...profile.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (b) => {
      log += b;
    });
    child.stderr.on("data", (b) => {
      log += b;
    });
    let viewer;
    try {
      await until(() => log.includes("Server listening"));
      const line = log
        .split("\n")
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return {};
          }
        })
        .find((m) => m.message === "Server listening");
      // Port zero requests an ephemeral port; ws server reports its actual listener.
      assert.ok(line.port > 0, log);
      const url = "ws://127.0.0.1:" + line.port;
      viewer = await connect(url);
      const events = [];
      viewer.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "code_agent_events") events.push(...m.data);
        if (m.type === "code_agent_event") events.push(m.data);
      });
      await until(() => events.some((e) => e.type === "agent_message"));
      const caps = await rpc(url, {
        type: "session_capabilities",
        token: "test-token",
      });
      assert.deepEqual(caps.models[0].efforts, ["low", "medium", "high"]);
      const initialSettings = JSON.parse(
        readFileSync(join(dir, "startup-settings.json"), "utf8"),
      );
      assert.equal(initialSettings.effortLevel, profile.effort);
      assert.equal(initialSettings.fastMode, profile.fast);
      assert.equal(caps.effective_settings.effort, profile.effort);
      assert.equal(
        caps.effective_settings.speed,
        profile.fast ? "fast" : "standard",
      );
      assert.deepEqual(caps.models[0].speeds, ["standard", "fast"]);
      const bad = await rpc(url, {
        type: "user_turn",
        token: "bad",
        id: "bad-token",
        text: "no",
      });
      assert.equal(bad.reason, "unauthorized");
      const unsupported = await rpc(url, {
        type: "user_turn",
        token: "test-token",
        id: "bad-speed",
        text: "no",
        settings: { speed: "ultrafast" },
      });
      assert.equal(unsupported.status, "rejected");
      const payload = {
        type: "user_turn",
        token: "test-token",
        id: "client-one",
        text: "steer",
        settings: { model: "test-model", effort: "low", speed: "fast" },
        attachments: [
          {
            name: "../notes.txt",
            mime_type: "text/plain",
            base64_data: Buffer.from("exact attachment bytes").toString(
              "base64",
            ),
          },
        ],
      };
      const ack = await rpc(url, payload);
      assert.equal(ack.status, "delivered");
      assert.equal(ack.delivery_mode, "steer");
      assert.equal(ack.effective_settings.effort, "low");
      assert.equal(ack.effective_settings.speed, "fast");
      const duplicate = await rpc(url, payload);
      assert.equal(duplicate.status, "duplicate");
      assert.equal(duplicate.turn_id, ack.turn_id);
      const steer2 = await rpc(url, {
        ...payload,
        id: "client-two",
        attachments: [],
        text: "second steer",
      });
      assert.equal(steer2.turn_id, ack.turn_id);
      await until(
        () => events.filter((e) => e.type === "user_turn").length === 2,
      );
      const turns = events.filter((e) => e.type === "user_turn");
      assert.deepEqual(
        turns.map((e) => e.client_message_id),
        ["client-one", "client-two"],
      );
      assert.equal(
        readFileSync(turns[0].attachments[0], "utf8"),
        "exact attachment bytes",
      );
      assert.ok(
        turns[0].attachments[0].startsWith(
          join(dir, "home", "attachments", "direct", "client-one"),
        ),
      );
      writeFileSync(join(dir, "release"), "");
      await until(() => events.some((e) => e.type === "turn_ended"));
      const usage = events.filter(
        (e) => e.type === "usage" && e.turn_id === ack.turn_id,
      );
      assert.equal(usage.at(-1).output_tokens, 5);
      assert.equal(usage.at(-1).usage_scope, "turn");
      const ended = events.find((e) => e.type === "turn_ended");
      assert.equal(ended.turn_id, ack.turn_id);
      assert.equal(ended.turn_outcome, "completed");
      assert.ok(
        Date.parse(ended.turn_ended_at) >= Date.parse(ended.turn_started_at),
      );
      const idle = await rpc(url, {
        type: "user_turn",
        token: "test-token",
        id: "idle-next",
        text: "next",
      });
      assert.equal(idle.delivery_mode, "start");
      assert.notEqual(idle.turn_id, ack.turn_id);
      await until(
        () => events.filter((e) => e.type === "turn_ended").length === 2,
      );
      const streamed = events.filter(
        (e) => e.type === "agent_message" && e.turn_id === ack.turn_id,
      );
      assert.ok(streamed.some((e) => e.partial));
      assert.equal(new Set(streamed.map((e) => e.item_id)).size, 1);
      assert.equal(streamed.at(-1).partial, false);
      const cursor = events.at(-2).seq;
      const replay = new WebSocket(url + "?cursor=" + cursor);
      try {
        const page = await new Promise((r, j) => {
          const timer = setTimeout(() => j(new Error("replay timeout")), 1000);
          replay.on("message", (raw) => {
            const m = JSON.parse(raw);
            if (m.type === "code_agent_events") {
              clearTimeout(timer);
              r(m.data);
            }
          });
        });
        assert.ok(page.length > 0);
        assert.ok(page.every((e) => e.seq > cursor));
      } finally {
        replay.close();
      }
    } finally {
      viewer?.close();
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    }
  });

const source = readFileSync(serverPath, "utf8");
const selectDefaults = vm.runInNewContext(
  source.slice(
    source.indexOf("function nativeModelOption("),
    source.indexOf("async function initializeNativeSettings("),
  ) + "\nnativeDefaultSettings",
);
// The native catalog Claude Code 2.1.305 returns from initialize (2026-10-28):
// aliases name their full model in resolvedModel; only Opus offers fast mode.
// Each tier's model gets its own entry's speed: Opus 5.5 (ultra) fast,
// Sonnet 5.5 (flash) standard.
test("tier models take their own catalog entry's fast mode: Opus 5.5 fast, Sonnet 5.5 standard", () => {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const catalog = [
    {
      value: "default",
      resolvedModel: "claude-opus-5-5",
      supportedEffortLevels: efforts,
      supportsFastMode: true,
    },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      supportedEffortLevels: efforts,
      supportsFastMode: true,
    },
    {
      value: "claude-fable-5-1[1m]",
      resolvedModel: "claude-fable-5-1",
      supportedEffortLevels: efforts,
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5-5",
      supportedEffortLevels: efforts,
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-5-5",
      supportedEffortLevels: efforts,
    },
  ];
  const settings = (model, env = {}) =>
    JSON.parse(JSON.stringify(selectDefaults(catalog, model, env)));
  const fast = { CLAUDE_CODE_SPEED: "fast" };
  const ultra = { CLAUDE_CODE_SPEED: "fast", CLAUDE_CODE_EFFORT: "xhigh" };
  // A Fast agent's request: fast where the entry supportsFastMode, else standard.
  assert.deepEqual(settings("claude-opus-5-5", fast), {
    effort: "medium",
    speed: "fast",
  });
  assert.deepEqual(settings("claude-opus-5-5", ultra), {
    effort: "xhigh",
    speed: "fast",
  });
  assert.deepEqual(settings("claude-sonnet-5-5", fast), {
    effort: "medium",
    speed: "standard",
  });
  assert.deepEqual(settings("claude-fable-5-1", fast), {
    effort: "medium",
    speed: "standard",
  });
  // The UI label comes from the alias entry ("Opus"), not "Default (recommended)".
  const option = vm.runInNewContext(
    source.slice(
      source.indexOf("function nativeModelOption("),
      source.indexOf("function nativeDefaultSettings("),
    ) + "\nnativeModelOption",
  );
  assert.equal(option(catalog, "claude-opus-5-5").value, "opus");
  assert.equal(option(catalog, "claude-sonnet-5-5").value, "sonnet");
  // Standard (or no request) is standard everywhere, even where fast is offered.
  assert.deepEqual(settings("claude-opus-5-5"), {
    effort: "medium",
    speed: "standard",
  });
  assert.deepEqual(
    settings("claude-opus-5-5", { CLAUDE_CODE_SPEED: "standard" }),
    { effort: "medium", speed: "standard" },
  );
});
test("Claude defaults use only advertised effort/speed and preserve explicit environment values", () => {
  const catalog = [
    {
      value: "sonnet",
      supportedEffortLevels: ["low", "medium", "high"],
      supportsFastMode: false,
    },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(selectDefaults(catalog, "claude-sonnet-5", {}))),
    { effort: "medium", speed: "standard" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(selectDefaults([], "unknown", {}))),
    { speed: "standard" },
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        selectDefaults(catalog, "claude-sonnet-5", {
          CLAUDE_CODE_EFFORT: "high",
          CLAUDE_CODE_SPEED: "standard",
          CLAUDE_CODE_FAST_MODE: "1",
        }),
      ),
    ),
    { effort: "high", speed: "standard" },
  );
  assert.throws(
    () =>
      selectDefaults(catalog, "claude-sonnet-5", {
        CLAUDE_CODE_SPEED: "ultrafast",
      }),
    /unsupported_settings/,
  );
  assert.equal(
    selectDefaults(catalog, "claude-sonnet-5", { CLAUDE_CODE_SPEED: "fast" })
      .speed,
    "standard",
    "a fast request on a model without fast mode runs standard",
  );
  assert.throws(
    () =>
      selectDefaults(catalog, "claude-sonnet-5", {
        CLAUDE_CODE_EFFORT: "invented",
      }),
    /unsupported_settings/,
  );
  assert.equal(
    selectDefaults(
      [
        {
          value: "model",
          supportedEffortLevels: ["high"],
          supportsFastMode: true,
        },
      ],
      "model",
      {},
    ).effort,
    undefined,
  );
});

test("Claude cold start: the first turn waits for a slow CLI initialize instead of failing settings_unconfirmed", async () => {
  // Cloud E2B cold starts answered initialize after more than 5.5s
  // (descend-full69-20261023 r002-j0010, agent 4f97f72e).
  const dir = mkdtempSync(join(tmpdir(), "rose-claude-cold-init-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "fake.cjs"), fake);
  writeFileSync(
    join(dir, "bin", "claude"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(dir, "fake.cjs")}'\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "release"), "");
  const child = spawn(process.execPath, [serverPath], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: join(dir, "bin") + ":" + process.env.PATH,
      HOME: join(dir, "home"),
      PORT: "0",
      CLAUDE_CODE_GOAL: "initial",
      CLAUDE_CODE_MODEL: "test-model",
      ANTHROPIC_API_KEY: "fake",
      CODE_SESSION_TURN_TOKEN: "test-token",
      RELEASE_FILE: join(dir, "release"),
      SETTINGS_FILE: join(dir, "startup-settings.json"),
      INIT_DELAY_MS: "6500",
      CLAUDE_CODE_FAST_MODE: "",
      CLAUDE_CODE_EFFORT: "",
      CLAUDE_CODE_SPEED: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => {
    log += b;
  });
  child.stderr.on("data", (b) => {
    log += b;
  });
  let viewer;
  try {
    await until(() => log.includes("Server listening"));
    const line = log
      .split("\n")
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return {};
        }
      })
      .find((m) => m.message === "Server listening");
    viewer = await connect("ws://127.0.0.1:" + line.port);
    const events = [];
    viewer.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "code_agent_events") events.push(...m.data);
      if (m.type === "code_agent_event") events.push(m.data);
    });
    const deadline = Date.now() + 15000;
    while (
      !events.some((e) => e.type === "result" || e.type === "final") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      events.filter((e) => e.type === "error").map((e) => e.message),
      [],
      log,
    );
    assert.ok(
      events.some((e) => e.type === "result"),
      "the delayed CLI must still receive and finish the first turn",
    );
    const startup = JSON.parse(
      readFileSync(join(dir, "startup-settings.json"), "utf8"),
    );
    assert.equal(startup.effortLevel, "medium");
  } finally {
    viewer?.close();
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(dir, { recursive: true, force: true });
  }
});
