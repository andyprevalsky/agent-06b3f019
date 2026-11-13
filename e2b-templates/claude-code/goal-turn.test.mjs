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
  readdirSync,
  utimesSync,
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

async function sendUserTurn(log, text, sender = "user") {
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
          sender,
        }),
      );
    });
  } finally {
    ws.close();
  }
}

async function runGoal({
  task,
  handoffOnTurn,
  steer = null,
  steerSender = "user",
  staleHandoff = false,
  expectExit = true,
  withSchema = true,
}) {
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
  const withHandoff = (text) =>
    `${text}\n\nResult JSON Schema for ${handoffFile}:\n${schema}`;
  // A Mac (target "local") task carries no result schema (service.py).
  const goal = withSchema ? withHandoff(task) : task;
  if (staleHandoff) {
    // A previous spawn's handoff that its close failed to consume.
    mkdirSync(dirname(handoffFile), { recursive: true });
    writeFileSync(handoffFile, "{}");
    if (staleHandoff !== "fresh") {
      const hourAgo = new Date(Date.now() - 3_600_000);
      utimesSync(handoffFile, hourAgo, hourAgo);
    }
  }
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
      const ack = await sendUserTurn(
        log,
        typeof steer === "function" ? steer(withHandoff) : steer,
        steerSender,
      );
      assert.equal(ack.status, "delivered", JSON.stringify(ack));
    }
    if (expectExit) {
      await until(() => existsSync(env.EXIT_FILE), `CLI exit\n${log}`);
      // The server logs this line before it closes the CLI's stdin; the exit
      // file can be seen before that stdout chunk is read under load.
      await until(
        () => log.includes('"Closing CLI stdin"'),
        `stdin close log\n${log}`,
      );
    } else {
      await until(
        () =>
          readFileSync(env.RECORD_FILE, "utf8").trim().split("\n").length >= 2,
        `user turn\n${log}`,
      );
      await new Promise((r) => setTimeout(r, 2000));
      assert.ok(!existsSync(env.EXIT_FILE), `the held session ended:\n${log}`);
    }
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

// Bug A (2026-11-12): every launch path starts the code agent with `/goal
// <goal>`, and a goal already written as `/goal ...` is not wrapped twice.
test("a Mac / local-fallback task without a result schema still starts as /goal", async () => {
  const { turns } = await runGoal({
    task: "Do it.",
    handoffOnTurn: 0,
    withSchema: false,
  });
  assert.equal(turns[0], "/goal Task:\nDo it.");
});

test("a goal already written as /goal is not wrapped twice", async () => {
  const { turns } = await runGoal({
    task: "/goal Do it.",
    handoffOnTurn: 1,
  });
  assert.equal(turns[0], "/goal Task:\nDo it.");
});

test("a new spawn's goal on a live CLI starts as /goal, never wrapped twice", async () => {
  const { turns } = await runGoal({
    task: "Do it.",
    handoffOnTurn: 0,
    steer: (withHandoff) => withHandoff("Task:\n/goal Then test it."),
    steerSender: "agent",
  });
  assert.equal(turns[1], "/goal Task:\nThen test it.");
});

test("a handoff left before the goal started never hands a held session back", async () => {
  const { log } = await runGoal({
    task: "Do it.",
    handoffOnTurn: 0,
    steer: "use the auto updater",
    staleHandoff: true,
    expectExit: false,
  });
  assert.ok(!log.includes("goal handoff written"), log);
});

test("a leftover handoff with a current timestamp is moved aside and never hands the session back", async () => {
  const { log, handoffFile } = await runGoal({
    task: "Do it.",
    handoffOnTurn: 0,
    steer: "use the auto updater",
    staleHandoff: "fresh",
    expectExit: false,
  });
  assert.ok(!log.includes("goal handoff written"), log);
  const kept = readdirSync(dirname(handoffFile)).filter((n) =>
    n.startsWith("handoff.json.superseded-"),
  );
  assert.equal(kept.length, 1, "the leftover handoff is kept, not deleted");
});
