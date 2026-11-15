#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { encryptArtifact, type StoredEncryptedArtifact } from '../../providers/traceArchive';
import {
  materializeArchiveLlmDumps,
  archiveRecoveryBackend,
} from '../../providers/archiveLlmMaterialization';

const root = randomUUID();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-llm-owner-'));
process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'test';
process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 23).toString('base64');
const base = (agent: string = root, dump = 'first') => ({
  root_agent_id: root,
  agent_id: agent,
  dump_id: dump,
  span_id: 'span',
  messages: [{ role: 'user', content: 'actual request' }],
  config: { keep: 1 },
  extra: { keep: 2 },
});
function fixture() {
  const objects = new Map<string, StoredEncryptedArtifact>();
  const add = (name: string, payload: unknown, timestamp: number): void => {
    const stored = encryptArtifact(name, Buffer.from(JSON.stringify(payload)), 'application/json');
    assert.ok(stored);
    stored.metadata.created_at_ms = timestamp;
    objects.set(name, stored);
  };
  add('llm/first.json.gz.enc', base(), 100);
  add('llm/second.json.gz.enc', base('child', 'second'), 200);
  add(
    'llm-updates/first-update.json.gz.enc',
    {
      ...base(),
      messages: undefined,
      output: 'actual response',
      span_id: 'current-update-context',
      config: { added: 3 },
      extra: { added: 4 },
    },
    300
  );
  return {
    objects,
    add,
    reader: {
      list: async (id: string) => {
        assert.equal(id, root);
        return [...objects.keys()].map((name) => ({ path: name }));
      },
      read: async (id: string, name: string) => {
        assert.equal(id, root);
        return objects.get(name) ?? null;
      },
    },
  };
}
async function main(): Promise<void> {
  let count = 0;
  assert.equal(archiveRecoveryBackend(undefined), 'r2');
  assert.equal(archiveRecoveryBackend(''), 'r2');
  assert.equal(archiveRecoveryBackend('local'), 'local');
  assert.equal(archiveRecoveryBackend('fake-r2'), 'fake-r2');
  count++;
  const { objects, reader } = fixture();
  const result = await materializeArchiveLlmDumps(root, directory, reader);
  assert.equal(result.baseCallCount, 2);
  assert.equal(result.updateCount, 1);
  assert.deepEqual(result.agentIds, [root, 'child'].sort());
  assert.equal(result.latest.agentId, 'child');
  assert.equal(result.latest.recordedCreatedAtMs, 200); // later update is not a later call
  const first = result.calls.find((call) => call.dumpId === 'first');
  assert.ok(first);
  const payload = JSON.parse(fs.readFileSync(first.path, 'utf8'));
  assert.equal(payload.output, 'actual response');
  assert.equal(payload.span_id, 'span');
  assert.deepEqual(payload.config, { keep: 1, added: 3 });
  assert.deepEqual(payload.extra, { keep: 2, added: 4 });
  assert.equal('ts_ms' in payload, false);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(result.manifestPath)).mode & 0o777, 0o700);
  count++;
  for (const kind of [
    'missing',
    'orphan',
    'identity',
    'timestamp',
    'ciphertext',
    'aad',
    'path',
    'duplicate',
    'unsafe',
  ] as const) {
    const f = fixture();
    if (kind === 'missing') f.reader.read = async () => null;
    if (kind === 'orphan') f.objects.delete('llm/first.json.gz.enc');
    if (kind === 'identity')
      f.add('llm/first.json.gz.enc', { ...base(), root_agent_id: 'foreign' }, 100);
    if (kind === 'timestamp') f.objects.get('llm/first.json.gz.enc')!.metadata.created_at_ms = 0;
    if (kind === 'ciphertext') f.objects.get('llm/first.json.gz.enc')!.ciphertext[0] ^= 1;
    if (kind === 'aad') f.objects.get('llm/first.json.gz.enc')!.metadata.aad = 'foreign';
    if (kind === 'path') f.objects.get('llm/first.json.gz.enc')!.metadata.path = 'foreign';
    if (kind === 'duplicate')
      f.reader.list = async () => [
        { path: 'llm/first.json.gz.enc' },
        { path: 'llm/first.json.gz.enc' },
      ];
    if (kind === 'unsafe')
      f.add('llm/first.json.gz.enc', { ...base(), agent_id: '../escape' }, 100);
    await assert.rejects(() => materializeArchiveLlmDumps(root, directory, f.reader), Error, kind);
    count++;
  }
  // Actual public CLI, local encrypted storage only: output and environment work from repo cwd.
  const archiveDir = path.join(directory, 'archive');
  for (const [name, stored] of objects) {
    const target = path.join(archiveDir, 'trace-archive', root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, stored.ciphertext);
    fs.writeFileSync(`${target}.meta.json`, JSON.stringify(stored.metadata));
  }
  const cwd = path.resolve(__dirname, '../../../..');
  const cli = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'back-end/scripts/fetch-agent-llm-dumps.ts',
      root,
      '--output-dir',
      directory,
      '--json',
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_LOCAL_DIR: archiveDir,
      },
    }
  );
  assert.equal(cli.status, 0, cli.stderr);
  const help = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'back-end/scripts/fetch-agent-llm-dumps.ts', '--help'],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH } }
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /backend defaults to r2/);
  count++;
  const receipt = JSON.parse(cli.stdout);
  assert.equal(receipt.baseCallCount, 2);
  assert.equal(receipt.updateCount, 1);
  assert.equal(receipt.latest.agentId, 'child');
  assert.equal(receipt.latest.recordedCreatedAtMs, 200);
  assert.ok(receipt.manifestSha256);
  assert.equal('sources' in receipt, false);
  assert.equal('calls' in receipt, false);
  assert.equal(cli.stdout.includes('actual request'), false);
  count++;
  {
    // Equal clocks (a call that starts and finishes within one millisecond):
    // the base record lists before its update.
    const tie = fixture();
    tie.objects.clear();
    tie.add('llm/tie.json.gz.enc', base(root, 'tie'), 500);
    tie.add(
      'llm-updates/tie-500-final.json.gz.enc',
      { ...base(root, 'tie'), messages: undefined, output: 'tied' },
      500
    );
    const tied = await materializeArchiveLlmDumps(root, directory, tie.reader);
    assert.deepEqual(
      tied.sources.map((source) => source.path),
      ['llm/tie.json.gz.enc', 'llm-updates/tie-500-final.json.gz.enc']
    );
    count++;
  }
  process.stdout.write(
    `PASS archive materialization: ${count} controls, real AES-GCM and actual CLI/local archive`
  );
}
main()
  .catch((error: unknown) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
