import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { encryptArtifact, type StoredEncryptedArtifact } from '../../providers/traceArchive';
import { materializeArchiveLlmDumps } from '../../providers/archiveLlmMaterialization';

process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString('base64');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-archive-reader-'));
const root = crypto.randomUUID();
let networkCalls = 0;
const deny = (): never => {
  networkCalls++;
  throw new Error('Network forbidden in materialization fixture');
};
global.fetch = deny;
http.request = deny;
https.request = deny;
const objects = new Map<string, StoredEncryptedArtifact>();
function add(objectPath: string, payload: Record<string, unknown>, createdAtMs: number): void {
  const stored = encryptArtifact(
    objectPath,
    Buffer.from(JSON.stringify(payload)),
    'application/json'
  );
  assert.ok(stored);
  // Captured completion-clock fixture data, not changed native evidence or a producer clock.
  stored.metadata.created_at_ms = createdAtMs;
  objects.set(objectPath, stored);
}
const basePayload = (dump: string) => ({
  root_agent_id: root,
  agent_id: root,
  dump_id: dump,
  span_id: 'original-span',
  call_site: 'fixture',
  message_count: 1,
  messages: [{ role: 'user', content: 'fixture-request' }],
});
const patchPayload = (dump: string) => ({
  root_agent_id: root,
  agent_id: root,
  dump_id: dump,
  span_id: 'update-span',
  output: 'fixture-response',
});
const reader = {
  list: async () => [...objects.keys()].map((objectPath) => ({ path: objectPath })),
  read: async (_root: string, objectPath: string) => objects.get(objectPath) ?? null,
};
async function main(): Promise<void> {
  let controls = 0;
  // Seventeen actual base/update/submission clock triples from the failed mass archive.
  // Agent IDs and payloads are synthetic; both -24ms and -7ms inversions are retained.
  const timestamps: number[][] = [
    [1794371630756, 1794371630760, 1794371630759, 12],
    [1794371634070, 1794371634389, 1794371632753, 12],
    [1794371633756, 1794371634010, 1794371631986, 12],
    [1794371631219, 1794371631256, 1794371631219, 12],
    [1794372024974, 1794372025300, 1794372019691, 12],
    [1794371635844, 1794371636144, 1794371633523, 12],
    [1794371627560, 1794371627567, 1794371627560, 12],
    [1794371635643, 1794371635619, 1794371633087, 12],
    [1794371629459, 1794371629464, 1794371629458, 12],
    [1794371628142, 1794371628305, 1794371628142, 12],
    [1794371628915, 1794371628924, 1794371628912, 12],
    [1794371626048, 1794371629380, 1, 32],
    [1794371630562, 1794371630555, 1794371630554, 12],
    [1794371632388, 1794371632683, 1794371631706, 12],
    [1794371629479, 1794371632741, 1, 32],
    [1794372025640, 1794372025999, 1794372021896, 12],
    [1794372025336, 1794372025610, 1794372021118, 12],
  ];
  const originals = new Map<string, Buffer>();
  timestamps.forEach(([baseAt, updateAt, submittedAt, dumpLength], index) => {
    const dump = index.toString(16).padStart(dumpLength, '0');
    add(`llm/${dump}.json.gz.enc`, basePayload(dump), baseAt);
    add(
      dumpLength === 12
        ? `llm-updates/${dump}-${submittedAt}-update.json.gz.enc`
        : `llm-updates/${dump}-0000000000000001-ffffffffffffffffffffffffffffffff.json.gz.enc`,
      patchPayload(dump),
      updateAt
    );
  });
  for (const [objectPath, stored] of objects) {
    originals.set(objectPath, Buffer.from(JSON.stringify(stored)));
  }
  const recovered = await materializeArchiveLlmDumps(root, directory, reader);
  assert.equal(recovered.baseCallCount, 17);
  assert.equal(recovered.updateCount, 17);
  assert.equal(recovered.sources.filter((source) => source.proof.ordering).length, 2);
  for (const call of recovered.calls) {
    const payload = JSON.parse(fs.readFileSync(call.path, 'utf8'));
    assert.equal(payload.output, 'fixture-response');
    assert.equal(payload.span_id, 'original-span');
    assert.deepEqual(payload.messages, basePayload(call.dumpId).messages);
    assert.equal(call.appliedUpdates.length, 1);
  }
  for (const [objectPath, stored] of objects) {
    assert.deepEqual(Buffer.from(JSON.stringify(stored)), originals.get(objectPath));
  }
  assert.equal(
    recovered.latest.recordedCreatedAtMs,
    Math.max(...timestamps.map(([baseAt]) => baseAt))
  );
  controls++;
  const legacyDump = 'abcdef012345';
  const legacyBase = `llm/${legacyDump}.json.gz.enc`;
  const legacyUpdate = `llm-updates/${legacyDump}-1794371630554-update.json.gz.enc`;
  const prepare = () => {
    objects.clear();
    add(legacyBase, basePayload(legacyDump), 1794371630562);
    add(legacyUpdate, patchPayload(legacyDump), 1794371630555);
  };
  for (const mutation of [
    'orphan',
    'duplicate',
    'foreign-agent',
    'foreign-root',
    'wrong-dump',
    'malformed-path',
    'base-replacement',
  ] as const) {
    prepare();
    if (mutation === 'orphan') objects.delete(legacyBase);
    if (mutation === 'duplicate')
      add('llm/duplicate.json.gz.enc', basePayload(legacyDump), 1794371630562);
    if (mutation === 'foreign-agent')
      add(legacyUpdate, { ...patchPayload(legacyDump), agent_id: 'foreign-agent' }, 1794371630555);
    if (mutation === 'foreign-root')
      add(
        legacyUpdate,
        { ...patchPayload(legacyDump), root_agent_id: 'foreign-root' },
        1794371630555
      );
    if (mutation === 'wrong-dump')
      add(legacyUpdate, { ...patchPayload(legacyDump), dump_id: '000000000000' }, 1794371630555);
    if (mutation === 'malformed-path') {
      objects.delete(legacyUpdate);
      add(`llm-updates/${legacyDump}-update.json.gz.enc`, patchPayload(legacyDump), 1794371630555);
    }
    if (mutation === 'base-replacement')
      add(legacyUpdate, { ...patchPayload(legacyDump), messages: [] }, 1794371630555);
    await assert.rejects(materializeArchiveLlmDumps(root, directory, reader), Error, mutation);
    controls++;
  }
  // Node UUID/ordinal protocol keeps its strict base-ack timestamp rule.
  objects.clear();
  const nodeDump = 'abcdef0123456789abcdef0123456789';
  add(`llm/${nodeDump}.json.gz.enc`, basePayload(nodeDump), 200);
  add(
    `llm-updates/${nodeDump}-0000000000000001-ffffffffffffffffffffffffffffffff.json.gz.enc`,
    patchPayload(nodeDump),
    199
  );
  await assert.rejects(materializeArchiveLlmDumps(root, directory, reader), /pre-base/);
  controls++;
  objects.clear();
  add(`llm/${nodeDump}.json.gz.enc`, basePayload(nodeDump), 200);
  add(
    `llm-updates/${nodeDump}-0000000000000001-ffffffffffffffffffffffffffffffff.json.gz.enc`,
    { ...patchPayload(nodeDump), output: 'FIRST' },
    201
  );
  add(
    `llm-updates/${nodeDump}-0000000000000002-00000000000000000000000000000000.json.gz.enc`,
    { ...patchPayload(nodeDump), output: 'SECOND' },
    201
  );
  const ordered = await materializeArchiveLlmDumps(root, directory, reader);
  assert.equal(JSON.parse(fs.readFileSync(ordered.latest.path, 'utf8')).output, 'SECOND');
  controls++;
  assert.equal(networkCalls, 0);
  console.log(
    JSON.stringify({
      passed: controls,
      networkCalls,
      databaseCalls: 0,
      capturedBases: 17,
      capturedUpdates: 17,
    })
  );
}
main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'materialization fixture failed');
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
