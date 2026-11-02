/** Real generated CLI processes against a local HTTP server; no Rose agents or providers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_GRAPH_CLI_SCRIPT } from '../../providers/agentGraph/cli';

test('Rose account CLI: pagination, messaging, explicit spawn instructions and cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rose-account-cli-'));
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!req.headers.authorization?.startsWith('Bearer fixture-token')) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Fixture authentication missing' }));
      return;
    }
    if (req.url?.includes('cursor=oversized')) {
      res.end(JSON.stringify({ agents: ['x'.repeat(100000)] }));
      return;
    }
    calls.push({ method: req.method ?? '', url: req.url ?? '', body });
    const data = req.url?.includes('/account/spawn')
      ? { agent_id: 'fixture-created', url: 'https://example.test/agent', independent: true }
      : req.url?.includes('/account/messages')
        ? { status: 'delivered', message_id: body.message_id }
        : req.url?.startsWith('/account/agents/')
          ? {
              messages: [
                {
                  message_id: 'm1',
                  role: 'USER',
                  timestamp: '2026-10-31T00:00:00Z',
                  text: 'evidence',
                  more_command: 'rose-agents read a --message m1 --offset 4000 --json',
                },
              ],
              next_command: 'rose-agents read a --cursor continuation --json',
            }
          : {
              agents: [
                {
                  agent_id: 'a',
                  title: 'Test repair: database',
                  status: 'ACTIVE',
                  read_command: 'rose-agents read a --json',
                },
              ],
              next_command: 'rose-agents list --scope account --cursor continuation --json',
            };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const observations = join(dir, 'fetch-options.jsonl');
  const preload = join(dir, 'observe-fetch.cjs');
  await writeFile(
    preload,
    `const fs = require('node:fs');
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({route:new URL(url).pathname, deadline:options?.signal !== undefined}) + '\\n');
  return originalFetch(url, options);
};`
  );
  const file = join(dir, 'rose-agents.cjs');
  await writeFile(
    file,
    process.env.ROSE_ACCOUNT_CLI_BASELINE === undefined
      ? AGENT_GRAPH_CLI_SCRIPT
      : await readFile(process.env.ROSE_ACCOUNT_CLI_BASELINE, 'utf8')
  );
  const goal = join(dir, 'handoff.md');
  await writeFile(goal, 'Use /RCA. Preserve the failing artifact.');
  const instruction = join(dir, 'deploy.md');
  await writeFile(instruction, 'No permission to spawn.');
  const run = (args: string[], input?: string, featureFlag = 'true') =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', preload, file, ...args], {
        env: {
          ...process.env,
          ROSE_AGENTS_URL: `http://127.0.0.1:${port}`,
          ROSE_AGENTS_TOKEN: 'fixture-token',
          ROSE_AGENTS_TOKEN_FILE: join(dir, 'unused-token'),
          ROSE_ACCOUNT_AGENTS_ENABLED: featureFlag,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Owned CLI exceeded test deadline'));
      }, 10_000);
      child.stdout.on('data', (x) => {
        stdout += String(x);
      });
      child.stderr.on('data', (x) => {
        stderr += String(x);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  try {
    const gated = [
      ['list', '--scope', 'account'],
      ['read', 'a'],
      ['spawn'],
      ['send', 'a', 'evidence', '--scope', 'account'],
    ];
    for (const featureFlag of ['', 'false', '1']) {
      for (const args of gated) {
        const denied = await run(args, undefined, featureFlag);
        assert.equal(denied.code, 2);
        assert.match(denied.stderr, /disabled.*boxes.dev/);
      }
      const legacy = await run(['list', '--json'], undefined, featureFlag);
      assert.equal(legacy.code, 0, legacy.stderr);
    }
    assert(
      calls.every((entry) => !entry.url.startsWith('/account/')),
      'disabled commands make no account request'
    );
    const listed = await run([
      'list',
      '--scope',
      'account',
      '--project',
      'p',
      '--folder',
      'f',
      '--limit',
      '2',
      '--cursor',
      'opaque',
    ]);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /MORE: rose-agents list/);
    assert.match(calls.at(-1)?.url ?? '', /project=p&folder=f&limit=2&cursor=opaque/);
    const read = await run(['read', 'a', '--message', 'm1', '--offset', '4000']);
    assert.equal(read.code, 0);
    assert.match(read.stdout, /MORE MESSAGE:/);
    assert.match(read.stdout, /MORE: rose-agents read/);
    assert.match(calls.at(-1)?.url ?? '', /message=m1&offset=4000/);
    const sent = await run(
      ['send', 'a', '-', '--scope', 'account', '--id', 'stable-message'],
      'Exact evidence $with `literal` text'
    );
    assert.equal(sent.code, 0);
    assert.equal(calls.at(-1)?.body.text, 'Exact evidence $with `literal` text');
    assert.equal(calls.at(-1)?.body.message_id, 'stable-message');
    const args = [
      'spawn',
      '--project',
      'p',
      '--folder',
      'f',
      '--title',
      'Test repair: pending storage',
      '--goal-file',
      goal,
      '--id',
      'stable-spawn',
    ];
    const count = calls.length;
    assert.notEqual((await run(args)).code, 0);
    assert.equal(calls.length, count, 'no request without instructions');
    assert.notEqual((await run([...args, '--instruction-file', instruction])).code, 0);
    assert.equal(calls.length, count, 'non-authorizing instructions cannot allocate');
    await writeFile(
      instruction,
      '---\nrose-agent-spawn: true\n---\nUse only to delegate NOT INTRODUCED deploy failures.'
    );
    const created = await run([...args, '--instruction-file', instruction, '--json']);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).independent, true);
    assert.equal(calls.at(-1)?.body.project, 'p');
    assert.equal(calls.at(-1)?.body.folder, 'f');
    assert.equal(calls.at(-1)?.body.id, 'stable-spawn');
    assert.equal(calls.at(-1)?.body.goal, 'Use /RCA. Preserve the failing artifact.');
    assert.match((calls.at(-1)?.body.instruction as { sha256: string }).sha256, /^[a-f0-9]{64}$/);
    const before = calls.length;
    assert.notEqual((await run(['list', '--scope', 'account', '--all'])).code, 0);
    assert.equal(calls.length, before, 'reject unbounded/unknown flags before network');
    await writeFile(goal, 'x'.repeat(100001));
    const largeGoal = await run([...args, '--instruction-file', instruction]);
    assert.notEqual(largeGoal.code, 0);
    assert.match(largeGoal.stderr, /File exceeds 100000 bytes/);
    assert.equal(calls.length, before, JSON.stringify(calls.map((x) => x.url)));
    const oversized = await run(['list', '--scope', 'account', '--cursor', 'oversized']);
    assert.notEqual(oversized.code, 0);
    assert.match(oversized.stderr, /exceeds 65536 bytes/);
    const legacy = await run(['list', '--json']);
    assert.equal(legacy.code, 0, legacy.stderr);
    const observed = (await readFile(observations, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { route: string; deadline: boolean });
    assert(observed.some((entry) => entry.route === '/agents'));
    assert(
      observed
        .filter((entry) => entry.route === '/agents' || entry.route === '/token')
        .every((entry) => !entry.deadline),
      'legacy tree commands and token refresh retain their original deadline behavior'
    );
    assert(
      observed
        .filter((entry) => entry.route.startsWith('/account/'))
        .every((entry) => entry.deadline),
      'new bounded account requests have a deadline'
    );
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--instruction-file/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    await rm(dir, { recursive: true, force: true });
  }
});
