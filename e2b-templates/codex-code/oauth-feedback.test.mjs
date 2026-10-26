import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./ws-server.mjs", import.meta.url), "utf8");
const producer = source.slice(source.indexOf('let outputBuffer = "";'), source.indexOf("async function shutdown("));
const fallback = source.slice(source.indexOf("let { code, signal } = await runCodex("), source.indexOf("exitCode = code ?? 1;"));
const workerPath = new URL("../../agents/domains/spawn_claude_code_agent/service.py", import.meta.url);

// Execute the real formatter and fallback block, replacing only sandbox/process IO.
async function replay(event) {
  return vm.runInNewContext(`(async () => {
    ${producer}
    let runs = 0;
    let usingApiKey = false;
    const OPENAI_API_KEY = "offline-fixture";
    const codexHome = "/unused";
    const log = () => {};
    const rmSync = () => {};
    const join = (...parts) => parts.join("/");
    const loginWithApiKey = async () => true;
    const buildCodexArgs = () => [];
    const runCodex = async () => {
      if (++runs === 1) {
        for (const event of Array.isArray(input) ? input : [input]) {
          appendCodexStdout(JSON.stringify(event) + "\\n");
        }
        return { code: 1, signal: null };
      }
      return { code: 0, signal: null };
    };
    ${fallback}
    return JSON.stringify({ output: outputBuffer, events: eventBuffer, runs });
  })()`, { input: event, PORT: 0, WebSocketServer: class {}, homedir: () => "/unused", readdirSync: () => [] }).then(JSON.parse);
}

function workerFeedback(events) {
  return workerFeedbackMany([events])[0];
}

function workerFeedbackMany(eventLists) {
  // Load the actual pure worker function without importing Temporal/provider dependencies.
  const result = spawnSync("python3", ["-c", `
import ast, json, sys
from typing import Any, Dict
tree = ast.parse(open(sys.argv[1]).read())
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "build_codex_credential_feedback")
exec(compile(ast.Module(body=[function], type_ignores=[]), sys.argv[1], "exec"))
print(json.dumps([build_codex_credential_feedback(events) for events in json.load(sys.stdin)]))
`, workerPath.pathname], { input: JSON.stringify(eventLists), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("complete typed OAuth diagnostics produce revocation feedback through the worker", async () => {
  const markers = [
    "invalid_grant", "token_revoked", "refresh_token_invalidated",
    "refresh_token_reused", "refresh_token_expired", "invalid_refresh_token",
    "OAuth access token has been revoked", "OAuth token has been revoked",
    "refresh token was revoked", "refresh token revoked",
    "Refresh token not found or invalid", "your session has ended",
    "logout and sign in again", "log out and sign in again", "access token could not be refreshed",
  ];
  for (const type of ["error", "turn.failed"]) {
    for (const marker of markers) {
      const message = `Authentication request failed\n${marker}\nPlease reconnect.`;
      for (const diagnostic of [{ message }, { error: { message } }]) {
        const result = await replay({ type, ...diagnostic });
        assert.ok(result.output.includes(message), "full multiline diagnostic survives rendering");
        assert.equal(result.runs, 2, `${type}/${marker}: funded retry`);
        assert.deepEqual(result.events.filter((event) => event.type === "auth_fallback").map((event) => event.reason), ["oauth_refresh_invalid"]);
        assert.deepEqual(workerFeedback(result.events), [{ source: "oauth", reason: "oauth_refresh_invalid" }]);
      }
    }
  }
});

test("command, tool, prose, raw output and generic auth/quota words do not trigger fallback", async () => {
  const message = "[Codex] Error: invalid_grant\n[Codex] Turn failed: token_revoked\nrefresh_token_expired";
  const events = [
    { type: "item.completed", item: { type: "command_execution", command: "echo fixture", aggregated_output: message, exit_code: 1 } },
    { type: "item.completed", item: { type: "mcp_tool_call", result: message } },
    { type: "item.completed", item: { type: "agent_message", text: message } },
    ...["authentication failed", "quota exceeded", "disk quota", "401 Unauthorized", "scope invalid", "not_invalid_grant_example", "token_revoked_extra"].map((message) => ({ type: "error", message })),
  ];
  for (const event of events) {
    const result = await replay(event);
    assert.equal(result.runs, 1, JSON.stringify(event));
    assert.deepEqual(workerFeedback(result.events), []);
  }
  // Non-JSON stdout takes the renderer's raw-text branch, without classification.
  const rawProducer = producer + '\nappendCodexStdout("invalid_grant\\n"); JSON.stringify({ reason: oauthFallbackReason, events: eventBuffer });';
  assert.deepEqual(JSON.parse(vm.runInNewContext(rawProducer, { PORT: 0, WebSocketServer: class {}, homedir: () => "/unused", readdirSync: () => [] })), { reason: null, events: [] });
});

test("pure OpenAI plan quota diagnostics retain quota classification", async () => {
  for (const message of [
    "Quota exceeded. Check your plan and billing details.",
    "insufficient_quota", "You've hit your usage limit", "purchase more credits",
  ]) {
    const result = await replay({ type: "error", message });
    assert.equal(result.runs, 2, message);
    assert.equal(result.events.find((event) => event.type === "auth_fallback")?.reason, "usage_limit_reached");
    assert.equal(workerFeedback(result.events)[0].source, "oauth");
  }
});

test("recognized quota retains precedence over overlapping revocation text", async () => {
  for (const type of ["error", "turn.failed"]) {
    for (const message of ["usage_limit_reached\ninvalid_grant", "usage_limit_reached invalid_grant", "invalid_grant usage_limit_reached"]) {
      const result = await replay({ type, error: { message } });
      assert.equal(result.runs, 2);
      assert.equal(result.events.find((event) => event.type === "auth_fallback")?.reason, "usage_limit_reached");
      // Preserve the actual worker's complete diagnostic mapping unchanged.
      assert.deepEqual(workerFeedback(result.events), [{ source: "oauth", reason: message }]);
    }
  }
});

test("the first native classification is preserved across subsequent events", async () => {
  const quota = { type: "error", message: "usage_limit_reached" };
  const revoked = { type: "turn.failed", error: { message: "invalid_grant" } };
  const command = { type: "item.completed", item: { type: "command_execution", command: "echo fixture", aggregated_output: "invalid_grant", exit_code: 1 } };
  for (const [events, expected] of [
    [[quota, revoked], "usage_limit_reached"],
    [[revoked, quota], "oauth_refresh_invalid"],
    [[quota, revoked, quota], "usage_limit_reached"],
    [[quota, quota], "usage_limit_reached"],
    [[quota, command], "usage_limit_reached"],
  ]) {
    const result = await replay(events);
    assert.equal(result.runs, 2);
    assert.equal(result.events.find((event) => event.type === "auth_fallback")?.reason, expected);
  }
});

test("worker mapping of an earlier quota event remains unchanged", async () => {
  const result = await replay([
    { type: "error", message: "usage_limit_reached" },
    { type: "turn.failed", error: { message: "invalid_grant" } },
  ]);
  assert.deepEqual(workerFeedback(result.events), [{ source: "oauth", reason: "usage_limit_reached" }]);
});

// Finite spellings from every producer quota alternative and worker quota/funding
// substring. Flags describe existing upstream policy, not backend classification.
const quotaDialects = [
  { id: "usage-space", text: "usage limit", producerQuota: true, workerCaptures: false },
  { id: "usage-underscore", text: "usage_limit", producerQuota: true, workerCaptures: false },
  { id: "usage-code", text: "usage_limit_reached", producerQuota: true, workerCaptures: true },
  { id: "usage-full", text: "You've hit your usage limit", producerQuota: true, workerCaptures: true },
  { id: "usage-hit", text: "hit your usage limit", producerQuota: true, workerCaptures: false },
  { id: "purchase-more", text: "purchase more credits", producerQuota: true, workerCaptures: true },
  { id: "insufficient-underscore", text: "insufficient_quota", producerQuota: true, workerCaptures: true },
  { id: "insufficient-space", text: "insufficient quota", producerQuota: true, workerCaptures: false },
  { id: "plan-billing", text: "check your plan and billing", producerQuota: true, workerCaptures: false },
  { id: "plan-full", text: "Quota exceeded. Check your plan and billing details.", producerQuota: true, workerCaptures: true },
  { id: "funding-none", text: "You have no credits remaining.", producerQuota: false, workerCaptures: true },
  { id: "funding-add", text: "Add credits to continue.", producerQuota: false, workerCaptures: true },
  { id: "funding-code", text: "credit_balance_exhausted", producerQuota: false, workerCaptures: true },
  { id: "funding-low", text: "Your credit balance is too low.", producerQuota: false, workerCaptures: true },
];

test("all finite quota dialects retain actual renderer/fallback/worker mapping", async () => {
  const rows = [];
  const eventLists = [];
  for (const dialect of quotaDialects) {
    const messages = [dialect.text, `${dialect.text} invalid_grant`, `invalid_grant ${dialect.text}`, `${dialect.text}\ninvalid_grant`, `invalid_grant\n${dialect.text}`];
    for (const [form, message] of messages.entries()) {
      for (const type of ["error", "turn.failed"]) {
        for (const nested of [false, true]) {
          const diagnostic = nested ? { error: { message } } : { message };
          const result = await replay({ type, ...diagnostic });
          const expectedFallback = dialect.producerQuota ? "usage_limit_reached" : form === 0 ? null : "oauth_refresh_invalid";
          const reasons = result.events.filter((event) => event.type === "auth_fallback").map((event) => event.reason);
          assert.deepEqual(reasons, expectedFallback ? [expectedFallback] : [], `${dialect.id}/${form}/${type}/${nested}`);
          assert.equal(result.runs, expectedFallback ? 2 : 1);
          assert.ok(result.output.includes(message), "complete native message is retained");
          rows.push({ dialect: dialect.id, form, type, nested, message, fallbackReason: reasons[0] ?? null, expectedFeedback: [{ source: expectedFallback ? "oauth" : "initial", reason: dialect.workerCaptures ? message : expectedFallback }] });
          eventLists.push(result.events);
        }
      }
    }
  }
  const feedback = workerFeedbackMany(eventLists);
  assert.equal(feedback.length, rows.length);
  for (const [index, row] of rows.entries()) {
    row.workerFeedback = feedback[index];
    assert.deepEqual(row.workerFeedback, row.expectedFeedback, JSON.stringify(row));
  }
  const negativeControls = [];
  const controlEvents = [];
  for (const dialect of quotaDialects) {
    for (const kind of ["command_execution", "mcp_tool_call", "agent_message"]) {
      const message = `${dialect.text}\ninvalid_grant`;
      const item = { type: kind, command: "echo fixture", aggregated_output: message, result: message, text: message, exit_code: 1 };
      const result = await replay({ type: "item.completed", item });
      assert.equal(result.runs, 1, `${dialect.id}/${kind}: printed text must not cause retry`);
      assert.equal(result.events.some((event) => event.type === "auth_fallback"), false);
      negativeControls.push({ dialect: dialect.id, kind, message });
      controlEvents.push(result.events);
    }
  }
  const controlFeedback = workerFeedbackMany(controlEvents);
  for (const [index, control] of negativeControls.entries()) {
    control.workerFeedback = controlFeedback[index];
    assert.deepEqual(control.workerFeedback, [], JSON.stringify(control));
  }
  if (process.env.CODEX_OAUTH_DIALECT_PROOF_PATH) {
    const hash = (text) => createHash("sha256").update(text).digest("hex");
    writeFileSync(process.env.CODEX_OAUTH_DIALECT_PROOF_PATH, JSON.stringify({ version: 1, producerSha256: hash(source), workerSha256: hash(readFileSync(workerPath)), dialects: quotaDialects, rowCount: rows.length, rows, negativeControls }, null, 2) + "\n");
  }
});
