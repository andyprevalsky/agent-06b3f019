/**
 * Behavioral contract for the environment the Claude Code CLI child receives.
 *
 * Runs the REAL e2b-templates/claude-code/ws-server.mjs (the file the backend
 * overlays into every E2B sandbox and spawns for the local fallback) with a
 * fake `claude` on PATH that records its own environment. That spawn is the
 * only place the CLI process is created, so what the fake sees is exactly what
 * the real CLI sees in production.
 *
 * Invariant: the CLI's streaming idle watchdog is ON. It is off by default in
 * the CLI, and without it a silently dropped /v1/messages stream hangs the
 * session with zero output until our outer timeout (agent 28b8f555 stalled
 * 233s inside its second streaming request). The CLI's own idle timeout
 * default (90s) is kept, so CLAUDE_STREAM_IDLE_TIMEOUT_MS must not be set.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const wsServerPath = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'e2b-templates',
  'claude-code',
  'ws-server.mjs'
);
const fixtureDir = mkdtempSync(join(tmpdir(), 'claude-ws-cli-env-'));
const fakeBinDir = join(fixtureDir, 'bin');
mkdirSync(fakeBinDir, { recursive: true });

// Fake CLI: read the stream-json prompt line (ws-server keeps stdin open until
// the turn's result), record the env it was launched with, then emit a
// successful result so ws-server closes stdin and the run finishes normally.
const fakeClaudePath = join(fakeBinDir, 'claude');
writeFileSync(
  fakeClaudePath,
  `#!${process.execPath}
const { writeFileSync } = require('node:fs');
let stdin = '';
let answered = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
  let newline;
  while (!answered && (newline = stdin.indexOf('\\n')) !== -1) {
  const line = stdin.slice(0, newline);
  stdin = stdin.slice(newline + 1);
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      request_id: message.request_id, subtype: 'success', response: { models: [] }
    } }) + '\\n');
    continue;
  }
  answered = true;
  writeFileSync(process.env.FAKE_CLAUDE_CAPTURE_PATH, JSON.stringify({
    streamWatchdog: process.env.CLAUDE_ENABLE_STREAM_WATCHDOG ?? null,
    streamIdleTimeoutMs: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ?? null,
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    stdin: line,
  }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`
);
chmodSync(fakeClaudePath, 0o755);

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

type CliEnvCapture = {
  streamWatchdog: string | null;
  streamIdleTimeoutMs: string | null;
  oauthToken: string | null;
  stdin: string;
};

async function captureCliEnv(
  label: string,
  inheritedEnv: Record<string, string>
): Promise<CliEnvCapture> {
  const home = join(fixtureDir, `home-${label}`);
  mkdirSync(home, { recursive: true });
  const capturePath = join(fixtureDir, `capture-${label}.json`);

  // No `...process.env`: the CLI env must come from ws-server itself, not
  // leak in from whatever shell runs this test.
  const server = spawn(process.execPath, [wsServerPath], {
    cwd: home,
    env: {
      PATH: [fakeBinDir, process.env.PATH ?? ''].filter(Boolean).join(':'),
      HOME: home,
      PORT: '0',
      CLAUDE_CODE_GOAL: 'report the stream watchdog contract',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      FAKE_CLAUDE_CAPTURE_PATH: capturePath,
      ...inheritedEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  let serverExited = false;
  const exited = new Promise<void>((resolveExit) => {
    server.once('exit', () => {
      serverExited = true;
      resolveExit();
    });
  });
  // ws-server logs "Claude Code CLI exited" from the child's close handler, i.e.
  // after the fake CLI has written its capture and exited. Event-driven: no polling.
  const cliExited = new Promise<void>((resolveCli, rejectCli) => {
    const timer = setTimeout(
      () => rejectCli(new Error(`fake claude did not run within 20s:\n${serverOutput}`)),
      20_000
    );
    const onOutput = (chunk: Buffer): void => {
      serverOutput += chunk.toString('utf8');
      if (serverOutput.includes('"message":"Claude Code CLI exited"')) {
        clearTimeout(timer);
        resolveCli();
      }
    };
    server.stdout.on('data', onOutput);
    server.stderr.on('data', onOutput);
    void exited.then(() => {
      clearTimeout(timer);
      rejectCli(new Error(`ws-server exited before the CLI finished:\n${serverOutput}`));
    });
  });

  try {
    await cliExited;
    assert.ok(existsSync(capturePath), `fake claude never recorded its env:\n${serverOutput}`);
    return JSON.parse(readFileSync(capturePath, 'utf8')) as CliEnvCapture;
  } finally {
    if (!serverExited) server.kill('SIGTERM');
    await exited;
  }
}

test('ws-server launches the Claude Code CLI with its stream idle watchdog enabled', async () => {
  const env = await captureCliEnv('default', {});

  // Same env path that carries auth to the CLI — proves this is the real child env.
  assert.equal(env.oauthToken, 'test-oauth-token');
  assert.match(env.stdin, /report the stream watchdog contract/);

  assert.equal(
    env.streamWatchdog,
    '1',
    'REGRESSION: Claude Code CLI spawned without CLAUDE_ENABLE_STREAM_WATCHDOG=1; a dropped ' +
      'streaming response will hang the session with zero output until the outer timeout.'
  );
  assert.equal(
    env.streamIdleTimeoutMs,
    null,
    'CLAUDE_STREAM_IDLE_TIMEOUT_MS must stay unset so the CLI keeps its own 90s default.'
  );
});

test('ws-server forces the watchdog on even when the sandbox env disables it', async () => {
  const env = await captureCliEnv('inherited-off', { CLAUDE_ENABLE_STREAM_WATCHDOG: '0' });
  assert.equal(env.streamWatchdog, '1');
});

function nativeClaudeEmitter(events: Record<string, unknown>[]): (message: unknown) => void {
  const source = readFileSync(wsServerPath, 'utf8');
  const parsed = ts.createSourceFile(
    wsServerPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const declaration = parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'emitClaudeMessage'
  );
  assert.ok(declaration, 'real native event emitter must exist');
  return runInNewContext(`(${declaration.getText(parsed)})`, {
    appendEvent: (event: Record<string, unknown>) => events.push(event),
  }) as (message: unknown) => void;
}

test('native Claude result codec preserves action identity and error evidence', () => {
  const events: Record<string, unknown>[] = [];
  const emit = nativeClaudeEmitter(events);
  for (const isError of [false, true]) {
    const result = { stdout: 'original tool output', exitCode: isError ? 1 : 0 };
    emit({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'native-call-17', is_error: isError }],
      },
      tool_use_result: result,
    });
    const event = events.at(-1);
    assert.equal(event?.tool_use_id, 'native-call-17');
    assert.equal(event?.is_error, isError);
    assert.equal(event?.tool_use_result, result);
  }
  // A legacy/ambiguous payload remains explicitly unknown, never inferred success.
  emit({ type: 'user', tool_use_result: { stdout: 'unbound output' } });
  assert.equal(events.at(-1)?.tool_use_id, null);
  assert.equal(events.at(-1)?.is_error, null);
});

test('native Claude batch retains every original block without assigning shared metadata', () => {
  const events: Record<string, unknown>[] = [];
  const emit = nativeClaudeEmitter(events);
  const blocks = [
    { type: 'tool_result', tool_use_id: 'native-first', is_error: false, content: 'first output' },
    { type: 'tool_result', tool_use_id: 'native-second', is_error: true, content: 'second error' },
  ];
  const shared = { stdout: 'ambiguous shared output' };
  emit({ type: 'user', message: { content: blocks }, tool_use_result: shared });
  const event = events.at(-1);
  assert.deepEqual(event?.tool_results, blocks);
  assert.equal(event?.tool_use_result, shared);
  assert.equal(event?.tool_use_id, null);
  assert.equal(event?.is_error, null);
});
