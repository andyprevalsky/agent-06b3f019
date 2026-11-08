// Every code-agent task starts as Claude Code's own `/goal`, whose condition ends
// with the result handoff (Andy, 2026-11-08, root 0874662a: code agents had no
// clean end condition and one stopped to ask the user a question). Rose adds no
// continuation of its own; the CLI's goal evaluator keeps it working.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const WebSocket = createRequire(import.meta.url)("ws");

const serverPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "ws-server.mjs",
);

// Records every user message, answers each with a result, and writes the
// handoff on the turn named by HANDOFF_ON_TURN (0: never).
const fake = String.raw`
const {createInterface}=require('node:readline');
const {appendFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {dirname}=require('node:path');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let turn=0;
createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(msg.type==='control_request'){
  const response=msg.request.subtype==='initialize'?{models:[{value:'test-model',displayName:'t',supportedEffortLevels:['medium'],supportsFastMode:false}]}:{};
  send({type:'control_response',response:{request_id:msg.request_id,subtype:'success',response}});return;
 }
 if(msg.type!=='user')return;
 turn++;
 const text=msg.message.content.map(p=>p.text||'').join('');
 appendFileSync(process.env.RECORD_FILE,JSON.stringify(text)+'\n');
 if(process.env.HOLD_FIRST&&turn===1)return; // still working when the user steers
 if(Number(process.env.HANDOFF_ON_TURN)===turn){mkdirSync(dirname(process.env.HANDOFF_FILE),{recursive:true});writeFileSync(process.env.HANDOFF_FILE,'{}');}
 send({type:'assistant',message:{id:'m'+turn,content:[{type:'text',text:'ok'}]}});
 send({type:'result',subtype:'success',result:'ok',queued_turn_count:0});
}).on('close',()=>{writeFileSync(process.env.EXIT_FILE,'exited');process.exit(0);});
`;

async function until(predicate, what) {
  for (let i = 0; i < 1500; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function sendUserTurn(log, text) {
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
  const ws = new WebSocket(`ws://127.0.0.1:${line.port}?replay=0`);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ack timeout")), 8000);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "user_turn_ack") {
          clearTimeout(timer);
          resolve(m);
        }
      });
      ws.send(
        JSON.stringify({
          type: "user_turn",
          token: "test-token",
          id: "u-1",
          text,
        }),
      );
    });
  } finally {
    ws.close();
  }
}

async function runGoal({ task, handoffOnTurn, steer = null }) {
  const dir = mkdtempSync(join(tmpdir(), "rose-goal-turn-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "fake.cjs"), fake);
  writeFileSync(
    join(dir, "bin", "claude"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(dir, "fake.cjs")}'\n`,
    { mode: 0o755 },
  );
  const handoffFile = join(dir, "home", ".rose", "handoff.json");
  const schema = JSON.stringify({
    type: "object",
    required: ["rose_handoff"],
  });
  const goal = `${task}\n\nResult JSON Schema for ${handoffFile}:\n${schema}`;
  const env = {
    ...process.env,
    PATH: join(dir, "bin") + ":" + process.env.PATH,
    HOME: join(dir, "home"),
    PORT: "0",
    CLAUDE_CODE_GOAL: goal,
    CLAUDE_CODE_MODEL: "test-model",
    ANTHROPIC_API_KEY: "fake",
    CODE_SESSION_TURN_TOKEN: "test-token",
    RECORD_FILE: join(dir, "record.jsonl"),
    EXIT_FILE: join(dir, "exited"),
    HANDOFF_FILE: handoffFile,
    HANDOFF_ON_TURN: String(handoffOnTurn),
    HOLD_FIRST: steer ? "1" : "",
    // A held session must end on the handoff, not on this idle window.
    CODE_SESSION_DIRECT_HOLD_IDLE_MS: "600000",
  };
  const child = spawn(process.execPath, [serverPath], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  try {
    if (steer) {
      await until(() => existsSync(env.RECORD_FILE), `goal turn\n${log}`);
      const ack = await sendUserTurn(log, steer);
      assert.equal(ack.status, "delivered", JSON.stringify(ack));
    }
    await until(() => existsSync(env.EXIT_FILE), `CLI exit\n${log}`);
    const turns = readFileSync(env.RECORD_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { dir, turns, handoffFile, schema, log };
  } finally {
    child.kill("SIGTERM");
  }
}

test("the task starts as /goal with its end condition; the schema goes to a file", async () => {
  const task = "Remove the rose ring.\n\nEnd condition: write the handoff.";
  const { turns, handoffFile, schema } = await runGoal({
    task,
    handoffOnTurn: 1,
  });
  assert.equal(turns.length, 1, JSON.stringify(turns));
  assert.ok(turns[0].startsWith("/goal "), turns[0]);
  assert.ok(turns[0].endsWith(`Task:\n${task}`), turns[0]);
  assert.ok(!turns[0].includes("Result JSON Schema"), turns[0]);
  const schemaFile = join(dirname(handoffFile), "handoff.schema.json");
  assert.equal(readFileSync(schemaFile, "utf8"), schema);
});

test("Rose adds no turns of its own: Claude Code's /goal decides when the goal is met", async () => {
  const { turns } = await runGoal({ task: "Do it.", handoffOnTurn: 0 });
  assert.equal(turns.length, 1, JSON.stringify(turns));
});

test("a task over the /goal cap goes to a task file the condition names", async () => {
  const task = "x".repeat(5000) + "\n\nEnd condition: write the handoff.";
  const { turns, handoffFile } = await runGoal({ task, handoffOnTurn: 1 });
  const taskFile = join(dirname(handoffFile), "task.md");
  assert.ok(turns[0].length <= 4006, String(turns[0].length));
  assert.ok(turns[0].startsWith("/goal "), turns[0].slice(0, 80));
  assert.ok(turns[0].includes(taskFile), turns[0]);
  assert.equal(readFileSync(taskFile, "utf8"), task);
});

test("a user's direct turn that writes the handoff hands the session back at once", async () => {
  const { turns, log } = await runGoal({
    task: "Do it.",
    handoffOnTurn: 2,
    steer: "i'm talking about the auto updater btw",
  });
  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.equal(turns[1], "i'm talking about the auto updater btw");
  assert.ok(log.includes("goal handoff written"), log);
});

test("a task already headed Task: is not headed twice", async () => {
  const { turns } = await runGoal({ task: "Task:\nDo it.", handoffOnTurn: 1 });
  assert.equal(turns[0], "/goal Task:\nDo it.");
});
