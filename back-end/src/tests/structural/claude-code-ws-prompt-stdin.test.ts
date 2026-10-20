import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(backendDir, '..');

// Cements the Claude Code CLI invocation contract in the E2B sandbox server.
//
// Claude Code CLI (>=2.x) IGNORES a positional prompt argument when
// `--print --output-format stream-json` is set and reads the prompt from stdin
// instead. Passing the goal positionally (with stdin ignored) makes the CLI exit
// 1 immediately with:
//   "Error: Input must be provided either through stdin or as a prompt argument
//    when using --print"
// which killed EVERY Claude Code session (0-output ~42s sessions in prod; the
// downstream "Paused sandbox not found" was a teardown-race mislabel). See
// docs/rca/cases/2026-08-05-claude-code-e2b-sandbox-dies-paused-not-found-ws502.md.
//
// The fix delivers the prompt on stdin. This test fails if a future edit
// reintroduces the positional-prompt / ignored-stdin invocation.
const wsServerPath = path.join(repoRoot, 'e2b-templates', 'claude-code', 'ws-server.mjs');

const src = fs.readFileSync(wsServerPath, 'utf8');

// The mode that triggers the CLI's stdin requirement must still be in use —
// otherwise this invariant is guarding a contract that no longer applies and
// should be revisited rather than silently passing.
assert.ok(
  /--output-format["\s,]+.*stream-json/s.test(src) || src.includes('"stream-json"'),
  'claude-code ws-server no longer uses --output-format stream-json; revisit the stdin-prompt invariant'
);

// 1. The prompt must NOT be pushed as a positional arg to the claude spawn.
assert.ok(
  !/args\.push\(\s*prompt\s*\)/.test(src),
  'REGRESSION: claude-code ws-server passes the prompt as a positional arg (args.push(prompt)). ' +
    'Under --output-format stream-json the CLI ignores it and exits 1 with "Input must be provided". ' +
    'Deliver the prompt on stdin instead.'
);

// 2. The claude child's stdin must be a pipe (not "ignore") so the prompt can
// be written. Scoped to the `spawn("claude", ...)` call: other children (the
// project startup script) may legitimately ignore stdin.
const claudeSpawnAt = src.indexOf('spawn("claude"');
assert.ok(
  claudeSpawnAt >= 0,
  'claude-code ws-server no longer spawns "claude"; revisit this invariant'
);
const claudeSpawn = src.slice(claudeSpawnAt, src.indexOf('});', claudeSpawnAt));
assert.ok(
  /stdio:\s*\[/.test(claudeSpawn) && !/stdio:\s*\[\s*["']ignore["']/.test(claudeSpawn),
  'REGRESSION: claude-code ws-server spawns claude with stdin "ignore"; the prompt cannot be delivered ' +
    'on stdin. Use stdio: ["pipe", "pipe", "pipe"].'
);

// 3. The prompt must actually be written to the child's stdin.
assert.ok(
  /\.stdin\.write\(\s*prompt\s*\)/.test(src) && /\.stdin\.end\(/.test(src),
  'REGRESSION: claude-code ws-server does not write the prompt to child.stdin. ' +
    'The Claude Code CLI reads the prompt from stdin under --output-format stream-json.'
);

console.log('claude-code-ws-prompt-stdin: OK (prompt delivered via stdin, not positional arg)');
