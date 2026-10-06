#!/usr/bin/env tsx
import assert from 'node:assert';
import { S3Client } from '@aws-sdk/client-s3';
import {
  encryptArtifact,
  decryptAndValidateArtifact,
  archiveJson,
  storePlainArtifact,
  archiveBytes,
} from '../../providers/traceArchive';
import { prisma } from '../../providers/database';
import {
  inspectFinalizedManifest,
  writeFinalizationMarker,
} from '../../providers/traceArchiveManifest';
import {
  ARCHIVE_BATCH_MAX_BYTES,
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
  await observeUntil(async () => {
    if (otherReady()) return true;
    const rows = await prisma.$queryRawUnsafe<{ waiting: number }[]>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'"
    );
    return (rows[0]?.waiting ?? 0) >= 1;
  });
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
    const rows = await prisma.$queryRaw<{ pid: number }[]>`
      SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database()
      AND l.objsubid = 1
      AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${rootAgentId + ':trace-archive-manifest'}, 8104327)
    `;
    assert.strictEqual(
      rows.length,
      1,
      'terminate only the positively identified fixture root lock holder'
    );
    const result = await prisma.$queryRaw<
      { terminated: boolean }[]
    >`SELECT pg_terminate_backend(${rows[0].pid}::int) AS terminated`;
    assert.strictEqual(result[0]?.terminated, true);
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
    withEnv(offlineArchiveEnvironment, async () => {
      const rootAgentId = 'offline-batch-root';
      const artifacts = Array.from({ length: 8 }, (_, index) => {
        const objectPath = `media/browser/task/frame-${index}.txt`;
        const encrypted = encryptArtifact(objectPath, Buffer.from(`frame ${index}`), 'text/plain');
        assert(encrypted);
        return {
          path: objectPath,
          metadata: encrypted.metadata,
          ciphertextB64: encrypted.ciphertext.toString('base64'),
        };
      });
      const sender = S3Client.prototype as unknown as {
        send: (command: unknown) => Promise<unknown>;
      };
      const originalSend = sender.send;
      const objects = new Map<string, Buffer>();
      let active = 0;
      let maximumActive = 0;
      let requests = 0;
      let failPath: string | null = null;
      sender.send = async (command: unknown) => {
        requests++;
        const name = command?.constructor?.name;
        const input = (command as { input: Record<string, unknown> }).input;
        assert.strictEqual(input.Bucket, 'offline');
        if (name === 'PutObjectCommand') {
          active++;
          maximumActive = Math.max(maximumActive, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (String(input.Key).endsWith(failPath ?? '\\0'))
              throw new Error('fixture store refused');
            objects.set(String(input.Key), bodyToBuffer(input.Body));
            return {};
          } finally {
            active--;
          }
        }
        if (name === 'HeadObjectCommand' || name === 'GetObjectCommand') {
          throw Object.assign(new Error('fixture absent'), {
            name: 'NoSuchKey',
          });
        }
        throw new Error(`unexpected storage command ${name}`);
      };
      try {
        const batch = { rootAgentId, artifacts };
        const reservedPath = artifacts[0].path + '.meta.json';
        const reserved = encryptArtifact(reservedPath, Buffer.from('reserved path'), 'text/plain');
        assert(reserved);
        for (const invalid of [
          {
            rootAgentId,
            artifacts: [
              artifacts[0],
              {
                path: reservedPath,
                metadata: reserved.metadata,
                ciphertextB64: reserved.ciphertext.toString('base64'),
              },
            ],
          },
          {
            ...batch,
            artifacts: [artifacts[0], { ...artifacts[1], metadata: {} }],
          },
          { ...batch, padding: 'x'.repeat(ARCHIVE_BATCH_MAX_BYTES) },
          {
            ...batch,
            artifacts: [
              artifacts[0],
              {
                ...artifacts[1],
                ciphertextB64: artifacts[1].ciphertextB64 + '\n',
              },
            ],
          },
        ]) {
          await assert.rejects(storeWorkerArtifacts(invalid), /Archive /);
          assert.strictEqual(requests, 0, 'invalid later records must not partially publish');
        }
        const result = await storeWorkerArtifacts(batch);
        assert.deepStrictEqual(
          result.artifacts.map((item) => item.path),
          artifacts.map((item) => item.path)
        );
        assert.strictEqual(
          maximumActive,
          4,
          'storage concurrency must be bounded independently of record count'
        );
        for (const [index, artifact] of artifacts.entries()) {
          const ciphertext = objects.get(`trace-archive/${rootAgentId}/${artifact.path}`);
          const metadata = objects.get(`trace-archive/${rootAgentId}/${artifact.path}.meta.json`);
          assert(ciphertext && metadata);
          assert.strictEqual(
            decryptAndValidateArtifact({
              ciphertext,
              metadata: JSON.parse(metadata.toString()),
            }).toString(),
            `frame ${index}`
          );
        }
        objects.clear();
        failPath = artifacts[1].path;
        await assert.rejects(storeWorkerArtifacts(batch), /disabled or unavailable/);
        assert.strictEqual(active, 0, 'a failed response must wait for all started uploads');
        assert(objects.size > 0, 'fixture must exercise partial remote acceptance');
        failPath = null;
        const retry = await storeWorkerArtifacts(batch);
        assert.strictEqual(retry.artifacts.length, artifacts.length);
        assert.strictEqual(
          objects.size,
          artifacts.length * 2,
          'retry must preserve every individual pair'
        );
      } finally {
        sender.send = originalSend;
      }
    })
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
