#!/usr/bin/env tsx
/**
 * R2 lossless audit (V13) C5 and C0 strictness against a local
 * TRACE_ARCHIVE_BACKEND=local archive with a mocked DB inventory:
 *
 *   C5  a session stored with a child id is audited under the tree root the
 *       mirror writes (archiveRootAgentId), and key presence alone is not a
 *       mirror: every object's sidecar must carry the checkpoint manifest's
 *       plaintext hash/size, its ciphertext its sidecar size, and the archived
 *       manifest (decrypted) the same artifact list
 *   C0  a prefix-decrypted (head) record is attributed but never counted as
 *       integrity-verified: WARN, not PASS
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archiveBytes, archiveJson } from '../../providers/traceArchive';
import {
  type AuditOptions,
  type CheckpointSource,
  type Inventory,
  archiveEncryptionKey,
  localArchiveSource,
} from '../../../scripts/audit-r2-lossless-core';
import {
  type AuditReport,
  type CheckResult,
  runAudit,
} from '../../../scripts/audit-r2-lossless-engine';
import { loadRecordSchema } from '../../../scripts/audit-r2-lossless-schema';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-lossless-code-mirror-'));
process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'test';
process.env.TRACE_ARCHIVE_BACKEND = 'local';
process.env.TRACE_ARCHIVE_ENABLED = 'true';
process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 41).toString('base64');

const NOW = Date.now();
const HOUR = 3_600_000;
const uuid = () => crypto.randomUUID();

function options(): AuditOptions {
  return {
    sinceMs: NOW - HOUR,
    untilMs: NOW + HOUR,
    nowMs: NOW + 2 * HOUR,
    v2CutoffMs: null,
    graceMs: 30 * 60_000,
    concurrency: 4,
    maxExamples: 10,
    headBytes: 1024,
    encryptionKey: archiveEncryptionKey(),
    schema: loadRecordSchema(),
  };
}

/** Checkpoint manifest naming `artifacts`, each holding its own name as bytes (as mirrorSeq writes). */
function checkpointManifest(artifacts: string[]): {
  artifacts: Record<string, { sha256: string; size: number }>;
} {
  return {
    artifacts: Object.fromEntries(
      artifacts.map((a) => [
        a,
        { sha256: crypto.createHash('sha256').update(a).digest('hex'), size: a.length },
      ])
    ),
  };
}

function checkpointSource(seqs: Record<string, number[]>, artifacts: string[]): CheckpointSource {
  return {
    listSeqs: async (_userId, sessionId) => seqs[sessionId] ?? [],
    readManifest: async () => checkpointManifest(artifacts),
  };
}

/** Mirror `names` of one checkpoint; manifest.json lists `listed` (default: the other names). */
async function mirrorSeq(
  rootId: string,
  sessionId: string,
  seq: number,
  names: string[],
  listed = names.filter((name) => name !== 'manifest.json')
): Promise<void> {
  for (const name of names) {
    assert.ok(
      await archiveBytes({
        rootAgentId: rootId,
        objectPath: `code/${sessionId}/${seq}/${name}`,
        body:
          name === 'manifest.json'
            ? Buffer.from(JSON.stringify(checkpointManifest(listed)))
            : Buffer.from(name),
        contentType: 'application/octet-stream',
        createOnly: true,
      })
    );
  }
}

function check(report: AuditReport, id: string): CheckResult {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `missing check ${id}`);
  return found;
}

/**
 * C5 counts a checkpoint as mirrored only under the tree root the mirror writes
 * (a session stored with a child id), and only when every object's sidecar
 * carries the manifest's plaintext hash and size and its ciphertext is intact.
 * C0 never PASSes a record it only prefix-decrypted.
 */
async function testCodeMirrorValidation(): Promise<void> {
  const rootId = uuid();
  const childId = uuid();
  const artifacts = ['cli-log.jsonl', 'worktree.tar.gz'];
  const names = ['manifest.json', ...artifacts];
  const [childSession, truncated, rehashed, noSidecar, badManifest] = [
    uuid(),
    uuid(),
    uuid(),
    uuid(),
    uuid(),
  ];
  for (const id of [childSession, truncated, rehashed, noSidecar]) {
    await mirrorSeq(rootId, id, 1, names);
  }
  await mirrorSeq(rootId, badManifest, 1, names, ['cli-log.jsonl']);
  const object = (id: string, name: string) =>
    path.join(directory, 'trace-archive', rootId, `code/${id}/1/${name}`);
  const ciphertext = fs.readFileSync(object(truncated, 'worktree.tar.gz'));
  fs.writeFileSync(object(truncated, 'worktree.tar.gz'), ciphertext.subarray(0, -4));
  const sidecar = `${object(rehashed, 'cli-log.jsonl')}.meta.json`;
  const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(sidecar, JSON.stringify({ ...meta, plaintext_sha256: '0'.repeat(64) }));
  fs.rmSync(`${object(noSidecar, 'worktree.tar.gz')}.meta.json`);

  const sessionRow = (id: string, stored = rootId) => ({
    id,
    userId: 'u',
    rootAgentId: stored,
    archiveRootAgentId: rootId,
    state: 'PAUSED',
    latestCheckpointSeq: 1,
  });
  const sessions = [childSession, truncated, rehashed, noSidecar, badManifest];
  const inventory: Inventory = {
    roots: [],
    hubRoots: [],
    treeAgents: [],
    activeChildren: [],
    ledger: [],
    codeSessions: sessions.map((id) => sessionRow(id, id === childSession ? childId : rootId)),
    bundleScan: null,
  };
  const source = checkpointSource(Object.fromEntries(sessions.map((id) => [id, [1]])), artifacts);
  const c5 = check(
    await runAudit(inventory, localArchiveSource(directory), source, options()),
    'C5'
  );
  assert.equal(c5.status, 'FAIL');
  assert.deepEqual(
    [c5.counts.mirrored, c5.counts.mirror_invalid, c5.counts.unmirrored],
    [1, 4, 0],
    c5.summary
  );
  const invalid = (c5.examples.mirror_invalid ?? []).join('\n');
  assert.match(invalid, new RegExp(`${truncated}/1 worktree\\.tar\\.gz: ciphertext`));
  assert.match(invalid, new RegExp(`${rehashed}/1 cli-log\\.jsonl: archived bytes differ`));
  assert.match(invalid, new RegExp(`${noSidecar}/1 worktree\\.tar\\.gz: missing \\.meta\\.json`));
  assert.match(invalid, new RegExp(`${badManifest}/1 manifest\\.json: artifacts differ`));
  assert.ok(!invalid.includes(childSession), 'the child-stored session is mirrored under its root');

  // Without the resolved root the audit would look in the child's (empty) bundle.
  const unresolved = { ...inventory, codeSessions: [{ ...sessionRow(childSession, childId) }] };
  delete unresolved.codeSessions[0].archiveRootAgentId;
  const c5Child = check(
    await runAudit(unresolved, localArchiveSource(directory), source, options()),
    'C5'
  );
  assert.deepEqual([c5Child.counts.mirrored, c5Child.counts.unmirrored], [0, 1]);

  // C0: a large start paired with a final that has content is only prefix-decrypted.
  const dumpId = crypto.randomBytes(6).toString('hex');
  const ids = { agent_id: rootId, root_agent_id: rootId, span_id: 'span', dump_id: dumpId };
  const big = crypto.randomBytes(20_000).toString('hex');
  assert.ok(
    await archiveJson({
      rootAgentId: rootId,
      objectPath: `llm/${dumpId}.json.gz.enc`,
      value: { call_site: 'execute_loop', ...ids, messages: [{ role: 'user', content: big }] },
    })
  );
  assert.ok(
    await archiveJson({
      rootAgentId: rootId,
      objectPath: `llm-updates/${dumpId}-${NOW}-update.json.gz.enc`,
      value: { ...ids, output: { content: 'done' } },
    })
  );
  const rootRow = {
    id: rootId,
    createdAtMs: NOW - 3 * HOUR,
    updatedAtMs: NOW - 3 * HOUR,
    status: 'COMPLETED',
    deleted: false,
    isBenchmark: false,
    model: 'rose-labs/rose-1-ultra',
    hasWorkflow: true,
  };
  const c0 = check(
    await runAudit(
      { ...inventory, roots: [rootRow], codeSessions: [] },
      localArchiveSource(directory),
      source,
      options()
    ),
    'C0'
  );
  assert.equal(c0.status, 'WARN', c0.summary);
  assert.deepEqual([c0.counts.unreadable, c0.counts.head_only_unverified], [0, 1]);
  assert.equal(c0.counts.verified, c0.counts.records - 1);
}

void testCodeMirrorValidation()
  .then(() => process.stdout.write('audit-r2-lossless-code-mirror: all tests passed\n'))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
