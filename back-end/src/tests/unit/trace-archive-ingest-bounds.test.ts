#!/usr/bin/env tsx
/**
 * Archive ingest never drops a record for size, and create-only publication is
 * resumable.
 *
 *   40 MB browser-step plaintext ─► batch + single worker ingest ─► stored, decrypts
 *   forged 2 GiB plaintext_bytes  ─► rejected (decompression-bomb guard only)
 *
 *   create-only retry after a lost sidecar ─► sidecar completed (Lane C confirm gate)
 *   undecryptable orphan body, no sidecar  ─► replaced by the complete artifact
 *   torn pair (our sidecar, foreign body)   ─► body repaired
 *   a different COMPLETE artifact exists    ─► never overwritten (null)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveBytes,
  decryptAndValidateArtifact,
  encryptArtifact,
  localObjectPath,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';
import { validatedArtifactBatch } from '../../providers/traceArchiveBatch';
import { storeWorkerArtifact, storeWorkerArtifacts } from '../../providers/traceArchiveLifecycle';

const originalEnv = { ...process.env };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-bounds-'));
process.env.TRACE_ARCHIVE_ENABLED = 'true';
process.env.TRACE_ARCHIVE_BACKEND = 'local';
process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 5).toString('base64');

/** ~40 MB step record: repetitive DOM plus an incompressible screenshot-like blob. */
function browserStepRecord(bytes: number): Buffer {
  const screenshot = crypto.randomBytes(Math.floor(bytes / 8)).toString('base64');
  const dom = '<div class="row"><span>step history entry</span></div>'.repeat(
    Math.ceil((bytes - screenshot.length) / 52)
  );
  return Buffer.from(
    JSON.stringify({ schema_version: 2, record: 'final', screenshot, dom }).slice(0, bytes)
  );
}

async function readBack(rootAgentId: string, objectPath: string): Promise<Buffer> {
  const stored = await readArchivedArtifactStrict({ rootAgentId, objectPath });
  assert(stored, `${objectPath} must be stored`);
  return decryptAndValidateArtifact(stored);
}

async function testLargeRecordsAreAccepted(): Promise<void> {
  const plaintext = browserStepRecord(40 * 1024 * 1024);
  assert(plaintext.length > 32 * 1024 * 1024, 'fixture must exceed the old 32 MiB cap');
  const root = `bounds-root-${process.pid}`;
  for (const [mode, objectPath] of [
    ['batch', 'llm-updates/browser-step-98-1-browser_step.json.gz.enc'],
    ['single', 'llm-updates/browser-step-99-2-browser_step.json.gz.enc'],
  ] as const) {
    const encrypted = encryptArtifact(objectPath, plaintext, 'application/json', true);
    assert(encrypted);
    const artifact = {
      path: objectPath,
      ciphertextB64: encrypted.ciphertext.toString('base64'),
      metadata: encrypted.metadata,
    };
    if (mode === 'batch') {
      validatedArtifactBatch({ rootAgentId: root, artifacts: [artifact] });
      await storeWorkerArtifacts({ rootAgentId: root, artifacts: [artifact] });
    } else {
      await storeWorkerArtifact({ rootAgentId: root, ...artifact });
    }
    const roundTrip = await readBack(root, objectPath);
    assert(roundTrip.equals(plaintext), `${mode} 40 MB record round-trips byte-identically`);
  }

  const small = encryptArtifact('llm/forged.json.gz.enc', Buffer.from('{}'), 'application/json');
  assert(small);
  assert.throws(
    () =>
      validatedArtifactBatch({
        rootAgentId: root,
        artifacts: [
          {
            path: 'llm/forged.json.gz.enc',
            ciphertextB64: small.ciphertext.toString('base64'),
            metadata: { ...small.metadata, plaintext_bytes: 2 * 1024 * 1024 * 1024 },
          },
        ],
      }),
    /exceeds bounds/
  );
}

async function testCreateOnlyResumes(): Promise<void> {
  const root = `create-only-root-${process.pid}`;
  const objectPath = 'code/session-1/0001/rollout.jsonl.gz.enc';
  const body = Buffer.from('{"turn":1}\n{"turn":2}\n');
  const target = localObjectPath(root, objectPath);
  const sidecar = `${target}.meta.json`;

  // 1) The sidecar write of an earlier attempt was lost: a retry completes it.
  assert(
    await archiveBytes({
      rootAgentId: root,
      objectPath,
      body,
      contentType: 'application/json',
      createOnly: true,
    })
  );
  fs.rmSync(sidecar);
  const resumed = await archiveBytes({
    rootAgentId: root,
    objectPath,
    body,
    contentType: 'application/json',
    createOnly: true,
  });
  assert(resumed, 'create-only retry must complete the missing sidecar');
  assert(fs.existsSync(sidecar));
  assert((await readBack(root, objectPath)).equals(body));

  // 2) An undecryptable orphan body (pre-fix random nonce, sidecar lost) is replaced.
  const orphanPath = 'code/session-1/0002/rollout.jsonl.gz.enc';
  const orphanTarget = localObjectPath(root, orphanPath);
  fs.mkdirSync(path.dirname(orphanTarget), { recursive: true });
  fs.writeFileSync(orphanTarget, crypto.randomBytes(64));
  assert(
    await archiveBytes({
      rootAgentId: root,
      objectPath: orphanPath,
      body,
      contentType: 'application/json',
      createOnly: true,
    }),
    'orphan body without a sidecar is completed by the next create-only write'
  );
  assert((await readBack(root, orphanPath)).equals(body));

  // 3) Torn pair: our sidecar was claimed but the body replacement never landed.
  const tornPath = 'code/session-1/0003/rollout.jsonl.gz.enc';
  const encrypted = encryptArtifact(tornPath, body, 'application/json', undefined, {
    deterministic: true,
  });
  assert(encrypted);
  const tornTarget = localObjectPath(root, tornPath);
  fs.mkdirSync(path.dirname(tornTarget), { recursive: true });
  fs.writeFileSync(tornTarget, crypto.randomBytes(64));
  fs.writeFileSync(`${tornTarget}.meta.json`, JSON.stringify(encrypted.metadata, null, 2));
  assert(
    await archiveBytes({
      rootAgentId: root,
      objectPath: tornPath,
      body,
      contentType: 'application/json',
      createOnly: true,
    })
  );
  assert((await readBack(root, tornPath)).equals(body), 'torn pair is repaired');

  // 4) A different complete artifact is never overwritten.
  const before = fs.readFileSync(target);
  assert.equal(
    await archiveBytes({
      rootAgentId: root,
      objectPath,
      body: Buffer.from('different'),
      contentType: 'application/json',
      createOnly: true,
    }),
    null
  );
  assert(fs.readFileSync(target).equals(before), 'existing complete artifact unchanged');
  assert((await readBack(root, objectPath)).equals(body));
}

async function main(): Promise<void> {
  try {
    await testLargeRecordsAreAccepted();
    await testCreateOnlyResumes();
    process.stdout.write('trace-archive-ingest-bounds: all checks passed\n');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
