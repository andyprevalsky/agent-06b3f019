#!/usr/bin/env tsx
import { boundedBatchValidation } from './trace-archive-batch-validation';
import { runArchiveCreationControls } from './trace-archive-creation-controls';
import assert from 'node:assert';
import { S3Client } from '@aws-sdk/client-s3';
import {
  decryptAndValidateArtifact,
  archiveJson,
  storePlainArtifact,
  archiveBytes,
} from '../../providers/traceArchive';
import { prisma } from '../../providers/database';
import {
  archiveManifestLockWaiters,
  inspectFinalizedManifest,
  writeFinalizationMarker,
} from '../../providers/traceArchiveManifest';
import {
  storeWorkerArtifacts,
  storeWorkerArtifact,
  archiveAgentStartFixture,
} from '../../providers/traceArchiveLifecycle';
import {
  bodyToBuffer,
  observeUntil,
  createTestHarness,
  withEnv,
  offlineArchiveArtifact as artifact,
} from './trace-archive-test-utils';

const offlineArchiveEnvironment = {
  TRACE_ARCHIVE_ENABLED: '1',
  TRACE_ARCHIVE_BACKEND: 'r2',
  // Offline mocked S3 client: deliberate R2 code path outside production.
  TRACE_ARCHIVE_ALLOW_NONPROD_R2: '1',
  TRACE_ARCHIVE_ENCRYPTION_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  R2_ACCOUNT_ID: 'offline',
  R2_ACCESS_KEY_ID: 'offline',
  R2_SECRET_ACCESS_KEY: 'offline',
  R2_BUCKET_TRACE_ARCHIVE: 'offline',
};

const { test, finish } = createTestHarness('archive batch storage tests');

const sender = S3Client.prototype as unknown as {
  send: (command: unknown) => Promise<unknown>;
};
const originalSend = sender.send;
const objects = new Map<string, Buffer>();
let onPublicWrite: ((key: string) => Promise<void>) | undefined;
let onEncryptedRead: ((key: string) => Promise<void>) | undefined;
let onManifestWrite: ((key: string) => Promise<void>) | undefined;
let activePuts = 0;
let fixturePuts = 0;
const interleavingSend = async (command: unknown) => {
  const name = command?.constructor?.name;
  const input = (command as { input: Record<string, unknown> }).input;
  assert.strictEqual(input.Bucket, 'offline');
  const key = String(input.Key);
  if (name === 'PutObjectCommand') {
    activePuts++;
    try {
      fixturePuts++;
      if (key.endsWith('/manifest.public.json') && onPublicWrite) await onPublicWrite(key);
      if (onManifestWrite) await onManifestWrite(key);
      if (input.IfNoneMatch === '*' && objects.has(key))
        throw Object.assign(new Error('offline object already exists'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      objects.set(key, bodyToBuffer(input.Body));
      return {};
    } finally {
      activePuts--;
    }
  }
  if (name === 'ListObjectsV2Command') {
    return {
      Contents: [...objects.keys()]
        .filter((value) => value.startsWith(String(input.Prefix)))
        .sort()
        .map((Key) => ({ Key })),
    };
  }
  if (name === 'GetObjectCommand' || name === 'HeadObjectCommand') {
    if (name === 'GetObjectCommand' && key.endsWith('/manifest.json.gz.enc') && onEncryptedRead)
      await onEncryptedRead(key);
    const body = objects.get(key);
    if (!body)
      throw Object.assign(new Error('offline fixture absent'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    return name === 'GetObjectCommand' ? { Body: body } : {};
  }
  throw new Error('Unexpected offline storage command: ' + name);
};

async function seed(rootAgentId: string) {
  const early = await archiveJson({
    rootAgentId,
    objectPath: 'llm/early.json.gz.enc',
    value: { early: true },
  });
  assert(early);
  const refs = [{ ref: early.ref, path: 'llm/early.json.gz.enc' }];
  await archiveJson({
    rootAgentId,
    objectPath: 'manifest.json.gz.enc',
    value: {
      finalized: true,
      artifacts: refs,
      sensitive: { artifact_refs: refs },
      benchmark_result: { passed: true },
      root_agent_id: rootAgentId,
    },
  });
  await storePlainArtifact({
    rootAgentId,
    objectPath: 'manifest.public.json',
    body: Buffer.from(JSON.stringify({ artifacts: refs })),
    contentType: 'application/json',
  });
  await writeFinalizationMarker(rootAgentId);
}

async function waitForAdvisoryWaiter(otherReady: () => boolean = () => false) {
  await observeUntil(async () => otherReady() || archiveManifestLockWaiters() >= 1);
}

/** Native lease loss: expire exactly this root's held manifest lease row. */
async function expireHeldManifestLease(rootAgentId: string): Promise<void> {
  const expired = await prisma.$executeRaw`
    UPDATE "TraceArchiveManifestLease" SET "expiresAt" = clock_timestamp() - interval '1 second'
    WHERE "rootAgentId" = ${rootAgentId} AND "expiresAt" > clock_timestamp()
  `;
  assert.strictEqual(expired, 1, 'expire only the positively identified fixture root lease');
}

async function sameRootInterleaving(kind: 'batch' | 'single') {
  objects.clear();
  const rootAgentId = 'offline-interleave-' + kind;
  await seed(rootAgentId);
  const firstArtifact = artifact('media/browser/first.txt');
  const laterArtifact = artifact('media/browser/later.txt');
  let second: Promise<unknown> | undefined;
  let hookCalls = 0;
  onPublicWrite = async (key) => {
    if (key !== 'trace-archive/' + rootAgentId + '/manifest.public.json' || hookCalls++) return;
    second =
      kind === 'batch'
        ? storeWorkerArtifacts({ rootAgentId, artifacts: [laterArtifact] })
        : storeWorkerArtifact({ rootAgentId, ...laterArtifact });
    // Prevent an early rejected promise from escaping before the owning join.
    void second.catch(() => {});
    await waitForAdvisoryWaiter();
  };
  const first = storeWorkerArtifacts({
    rootAgentId,
    artifacts: [firstArtifact],
  });
  void first.catch(() => {});
  const results: PromiseSettledResult<unknown>[] = [
    await first.then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    ),
  ];
  onPublicWrite = undefined;
  assert(second, 'fixture must start the actual second publication');
  results.push(
    await second.then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    )
  );
  const current = await inspectFinalizedManifest(rootAgentId);
  assert.strictEqual(activePuts, 0, 'all started storage writes must join');
  assert.strictEqual(
    current.status,
    'current',
    'final encrypted/public/object-store equality remains mandatory'
  );
  assert.strictEqual(
    current.actualArtifactCount,
    3,
    'both exact accepted artifacts and early artifact must remain'
  );
  for (const item of [firstArtifact, laterArtifact]) {
    assert(objects.has('trace-archive/' + rootAgentId + '/' + item.path));
    assert(objects.has('trace-archive/' + rootAgentId + '/' + item.path + '.meta.json'));
  }
  const failures = results.filter(
    (value): value is PromiseRejectedResult => value.status === 'rejected'
  );
  for (const failure of failures)
    assert(
      failure.reason instanceof Error &&
        failure.reason.message.includes('Trace archive manifest reconciliation did not converge'),
      'controlled race must reach the native owning nonconvergence boundary'
    );
  assert.strictEqual(
    results.filter((value) => value.status === 'rejected').length,
    0,
    'same-root publication must not invalidate another batch snapshot'
  );
  assert.strictEqual(hookCalls >= 1, true, 'controlled rewrite interleaving must actually execute');
}

async function differentRootIndependence() {
  objects.clear();
  await seed('offline-root-first');
  await seed('offline-root-second');
  let joinedOther = false;
  let hookCalls = 0;
  onPublicWrite = async (key) => {
    if (key !== 'trace-archive/offline-root-first/manifest.public.json' || hookCalls++) return;
    await storeWorkerArtifacts({
      rootAgentId: 'offline-root-second',
      artifacts: [artifact('media/other.txt')],
    });
    joinedOther = true;
  };
  await storeWorkerArtifacts({
    rootAgentId: 'offline-root-first',
    artifacts: [artifact('media/first.txt')],
  });
  onPublicWrite = undefined;
  assert(
    joinedOther,
    'an unrelated root must finish while the first root owns its publication lock'
  );
  assert.strictEqual((await inspectFinalizedManifest('offline-root-first')).status, 'current');
  assert.strictEqual((await inspectFinalizedManifest('offline-root-second')).status, 'current');
  assert.strictEqual(activePuts, 0);
}

function decodedManifest(rootAgentId: string) {
  const key = 'trace-archive/' + rootAgentId + '/manifest.json.gz.enc';
  const ciphertext = objects.get(key);
  const metadata = objects.get(key + '.meta.json');
  assert(ciphertext && metadata);
  return JSON.parse(
    decryptAndValidateArtifact({
      ciphertext,
      metadata: JSON.parse(metadata.toString()),
    }).toString()
  );
}

async function directWriterInterleaving() {
  objects.clear();
  const rootAgentId = 'offline-direct-writers';
  await seed(rootAgentId);
  let changes = 0;
  onPublicWrite = async (key) => {
    if (key !== 'trace-archive/' + rootAgentId + '/manifest.public.json') return;
    if (changes++ === 0) {
      assert(
        await archiveJson({
          rootAgentId,
          objectPath: 'provider/email.fixture.json.gz.enc',
          value: { fixture: true },
        })
      );
      const manifest = decodedManifest(rootAgentId);
      // Same terminal JSON, independently reserialized in a different key order.
      const reordered = Object.fromEntries(Object.entries(manifest).reverse());
      reordered.sensitive = Object.fromEntries(Object.entries(manifest.sensitive).reverse());
      assert(
        await archiveJson({
          rootAgentId,
          objectPath: 'manifest.json.gz.enc',
          value: reordered,
        })
      );
    } else if (changes === 2) {
      assert(
        await archiveBytes({
          rootAgentId,
          objectPath: 'provider/audio.fixture.bin',
          body: Buffer.from('offline fixture'),
          contentType: 'application/octet-stream',
        })
      );
    }
  };
  try {
    const result = await storeWorkerArtifacts({
      rootAgentId,
      artifacts: [artifact('media/browser/first.txt')],
    });
    assert.strictEqual(result.artifacts.length, 1);
    assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).status, 'current');
    assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).actualArtifactCount, 4);
    assert.deepStrictEqual(decodedManifest(rootAgentId).benchmark_result, {
      passed: true,
    });
    assert.strictEqual(
      changes,
      3,
      'two genuine additions must be followed by a stable full rewrite'
    );
    assert.strictEqual(activePuts, 0);
  } finally {
    onPublicWrite = undefined;
  }
}

async function lateStartInterleaving() {
  objects.clear();
  const rootAgentId = 'offline-late-start';
  await seed(rootAgentId);
  const fixture = {
    rows: {
      Agent: [
        {
          id: rootAgentId,
          isBenchmark: true,
          status: 'RUNNING',
          goal: 'offline fixture',
        },
      ],
    },
    agent_ids: [rootAgentId],
    user_id: 'offline-user',
    base_image: 'offline',
    captured_at: new Date().toISOString(),
  } as unknown as Parameters<typeof archiveAgentStartFixture>[1];
  let second: Promise<unknown> | undefined;
  let hookCalls = 0;
  onPublicWrite = async (key) => {
    if (key !== 'trace-archive/' + rootAgentId + '/manifest.public.json' || hookCalls++) return;
    let finished = false;
    second = archiveAgentStartFixture(rootAgentId, fixture).finally(() => {
      finished = true;
    });
    void second.catch(() => {});
    await waitForAdvisoryWaiter(() => finished);
  };
  let firstError: unknown;
  try {
    await storeWorkerArtifacts({
      rootAgentId,
      artifacts: [artifact('media/browser/first.txt')],
    });
  } catch (error) {
    firstError = error;
  } finally {
    onPublicWrite = undefined;
  }
  assert(second);
  await second;
  assert.strictEqual(activePuts, 0);
  assert.strictEqual(
    (await inspectFinalizedManifest(rootAgentId)).status,
    'current',
    'late start must preserve a finalized full manifest'
  );
  assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).actualArtifactCount, 3);
  assert.deepStrictEqual(decodedManifest(rootAgentId).benchmark_result, {
    passed: true,
  });
  assert.strictEqual(decodedManifest(rootAgentId).finalized, true);
  assert.strictEqual(
    firstError,
    undefined,
    'late start cannot replace the finalized snapshot with a start control file'
  );
}

async function startRetriesAfterLostLeasePreserveFinalization(
  target: 'manifest.json.gz.enc' | 'manifest.public.json'
) {
  objects.clear();
  const rootAgentId = 'offline-start-retry-' + target;
  const fixture = {
    rows: { Agent: [{ id: rootAgentId, isBenchmark: true, status: 'RUNNING' }] },
    agent_ids: [rootAgentId],
    user_id: 'offline-user',
    base_image: 'offline',
    captured_at: new Date().toISOString(),
  } as unknown as Parameters<typeof archiveAgentStartFixture>[1];
  let terminalObjects: Map<string, Buffer> | undefined;
  let killed = false;
  onManifestWrite = async (key) => {
    if (key !== 'trace-archive/' + rootAgentId + '/' + target) return;
    onManifestWrite = undefined;
    await expireHeldManifestLease(rootAgentId);
    killed = true;
    await seed(rootAgentId);
    terminalObjects = new Map([...objects].filter(([name]) => name.includes('/manifest.')));
    throw new Error('offline retryable write failure after the exact lease ended');
  };
  try {
    await archiveAgentStartFixture(rootAgentId, fixture);
    assert(killed && terminalObjects, 'retry must cross native lease loss and final publication');
    assert.strictEqual(activePuts, 0, 'late started storage work must join');
    for (const [key, body] of terminalObjects)
      assert.deepStrictEqual(objects.get(key), body, 'late start retry replaced ' + key);
    assert.strictEqual(decodedManifest(rootAgentId).finalized, true);
    assert.deepStrictEqual(decodedManifest(rootAgentId).benchmark_result, { passed: true });
  } finally {
    onManifestWrite = undefined;
  }
}

async function destructiveChangesRemainRejected() {
  for (const mode of ['removal', 'malformed'] as const) {
    objects.clear();
    const rootAgentId = 'offline-adverse-' + mode;
    await seed(rootAgentId);
    let changes = 0;
    onPublicWrite = async (key) => {
      if (key !== 'trace-archive/' + rootAgentId + '/manifest.public.json' || changes++) return;
      const target = 'trace-archive/' + rootAgentId + '/llm/early.json.gz.enc';
      if (mode === 'removal') {
        objects.delete(target);
        objects.delete(target + '.meta.json');
      } else
        objects.set(
          'trace-archive/' + rootAgentId + '/manifest.json.gz.enc.meta.json',
          Buffer.from('invalid JSON')
        );
    };
    try {
      await assert.rejects(
        storeWorkerArtifacts({
          rootAgentId,
          artifacts: [artifact('media/browser/first.txt')],
        })
      );
      assert.strictEqual(
        changes,
        1,
        'destructive changes and malformed evidence must not trigger another rewrite'
      );
      assert.strictEqual(activePuts, 0);
    } finally {
      onPublicWrite = undefined;
    }
  }
}

async function lostTransactionStopsWrites() {
  objects.clear();
  const rootAgentId = 'offline-transaction-loss';
  await seed(rootAgentId);
  let killed = false;
  let writesAtLoss = -1;
  onEncryptedRead = async (key) => {
    if (key !== 'trace-archive/' + rootAgentId + '/manifest.json.gz.enc' || killed) return;
    await expireHeldManifestLease(rootAgentId);
    killed = true;
    writesAtLoss = fixturePuts;
  };
  try {
    await assert.rejects(
      storeWorkerArtifacts({
        rootAgentId,
        artifacts: [artifact('media/browser/first.txt')],
      })
    );
    assert(killed, 'native exact fixture transaction loss must occur');
    assert.strictEqual(activePuts, 0, 'caller rejection must join its started storage work');
    assert.strictEqual(
      fixturePuts,
      writesAtLoss,
      'no rewrite may start after native transaction ownership was lost'
    );
  } finally {
    onEncryptedRead = undefined;
  }
}

async function main(): Promise<void> {
  await test(
    'whole batch validation precedes bounded uploads and failed batches remain retryable',
    withEnv(offlineArchiveEnvironment, boundedBatchValidation)
  );
  await withEnv(offlineArchiveEnvironment, async () => {
    sender.send = interleavingSend;
    try {
      await test('concurrent late batches retain both acknowledgements and full manifest equality', () =>
        sameRootInterleaving('batch'));
      await test('concurrent late single publication retains both acknowledgements and full manifest equality', () =>
        sameRootInterleaving('single'));
      await test('independent roots remain independent', differentRootIndependence);
      await test(
        'direct JSON and binary writers converge without losing terminal metadata',
        directWriterInterleaving
      );
      await test(
        'late start archival preserves terminal manifest ownership',
        lateStartInterleaving
      );
      await test(
        'removed artifacts and malformed evidence remain rejected without retry',
        destructiveChangesRemainRejected
      );
      await test(
        'native transaction ownership loss stops rewrites and joins work',
        lostTransactionStopsWrites
      );
      for (const target of ['manifest.json.gz.enc', 'manifest.public.json'] as const)
        await test('start retries after native lease loss preserve final ' + target, () =>
          startRetriesAfterLostLeasePreserveFinalization(target)
        );
      await runArchiveCreationControls(test, {
        objects,
        sender,
        interleavingSend,
        setWriteHook: (hook) => {
          onManifestWrite = hook;
        },
        getActivePuts: () => activePuts,
      });
    } finally {
      onPublicWrite = undefined;
      sender.send = originalSend;
      await prisma.$disconnect();
    }
  })();
  finish();
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
