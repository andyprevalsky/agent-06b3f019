import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveJson,
  encryptArtifact,
  storeEncryptedArtifact,
  readArchivedArtifact,
  decryptAndValidateArtifact,
  localObjectPath,
  listArchivedObjects,
} from '../../providers/traceArchive';
import { writePublicManifest } from '../../providers/traceArchiveManifest';
import { archiveAgentStartFixture } from '../../providers/traceArchiveLifecycle';
import { withEnv, createTestHarness } from './trace-archive-test-utils';

type CreationFixture = {
  objects: Map<string, Buffer>;
  sender: { send: (command: unknown) => Promise<unknown> };
  interleavingSend: (command: unknown) => Promise<unknown>;
  setWriteHook: (hook: ((key: string) => Promise<void>) | undefined) => void;
  getActivePuts: () => number;
};

export async function runArchiveCreationControls(
  test: ReturnType<typeof createTestHarness>['test'],
  fixture: CreationFixture
): Promise<void> {
  const { objects, sender, interleavingSend, setWriteHook, getActivePuts } = fixture;
  async function conditionalCreationDistinguishesExistingObjectsFromFailure() {
    for (const encrypted of [false, true]) {
      objects.clear();
      const rootAgentId = 'offline-create-errors-' + encrypted;
      const create = () =>
        encrypted
          ? archiveJson({
              rootAgentId,
              objectPath: 'manifest.json.gz.enc',
              value: { original: true },
              createOnly: true,
            })
          : writePublicManifest(rootAgentId, [], undefined, { createOnly: true });
      assert(await create());
      const accepted = new Map(objects);
      assert.strictEqual(await create(), null, 'an existing object is an intentional no-op');
      assert.deepStrictEqual(
        objects,
        accepted,
        'a precondition rejection must preserve stored bytes'
      );
      objects.clear();
      setWriteHook(async () => {
        throw new Error('offline create transport refused');
      });
      try {
        await assert.rejects(create(), /offline create transport refused/);
        assert.strictEqual(objects.size, 0);
        assert.strictEqual(getActivePuts(), 0);
      } finally {
        setWriteHook(undefined);
      }
    }
  }

  async function conditionalEncryptedCreationRetriesAcceptedBodySidecar() {
    objects.clear();
    const rootAgentId = 'offline-create-sidecar-retry';
    const objectPath = 'manifest.json.gz.enc';
    const bodyKey = 'trace-archive/' + rootAgentId + '/' + objectPath;
    let bodyWrites = 0;
    let sidecarWrites = 0;
    setWriteHook(async (key) => {
      if (key === bodyKey) bodyWrites++;
      if (key === bodyKey + '.meta.json' && ++sidecarWrites === 1)
        throw new Error('offline retryable sidecar failure after body acceptance');
    });
    const value = { finalized: false, fixture: 'accepted body and matching sidecar' };
    try {
      assert(await archiveJson({ rootAgentId, objectPath, value, createOnly: true }));
      const stored = await readArchivedArtifact({ rootAgentId, objectPath });
      assert(stored, 'the acknowledged pair must be readable through the ordinary archive reader');
      assert.deepStrictEqual(JSON.parse(decryptAndValidateArtifact(stored).toString()), value);
      assert.strictEqual(
        bodyWrites,
        1,
        'sidecar retries must retain the acknowledged encrypted body'
      );
      assert.strictEqual(sidecarWrites, 2);
      assert.strictEqual(getActivePuts(), 0);
    } finally {
      setWriteHook(undefined);
    }
  }

  async function conditionalEncryptedCreationRepairsAnEarlierAcceptedBody() {
    objects.clear();
    const rootAgentId = 'offline-create-cross-call';
    const objectPath = 'fixture.json.gz.enc';
    const value = { fixture: 'cross-call body acceptance' };
    const encrypted = encryptArtifact(
      objectPath,
      Buffer.from(JSON.stringify(value)),
      'application/json'
    );
    assert(encrypted);
    const params = { rootAgentId, objectPath, ...encrypted, createOnly: true };
    const bodyKey = 'trace-archive/' + rootAgentId + '/' + objectPath;
    let sidecarWrites = 0;
    setWriteHook(async (key) => {
      if (key === bodyKey + '.meta.json') {
        sidecarWrites++;
        throw new Error('offline exhausted sidecar transport');
      }
    });
    try {
      await assert.rejects(storeEncryptedArtifact(params), /offline exhausted sidecar transport/);
      assert.deepStrictEqual(objects.get(bodyKey), encrypted.ciphertext);
      assert(!objects.has(bodyKey + '.meta.json'));
      assert.strictEqual(sidecarWrites, 5);
    } finally {
      setWriteHook(undefined);
    }
    assert(
      await storeEncryptedArtifact(params),
      'the exact accepted body must resume its sidecar across calls'
    );
    const stored = await readArchivedArtifact({ rootAgentId, objectPath });
    assert(stored);
    assert.deepStrictEqual(JSON.parse(decryptAndValidateArtifact(stored).toString()), value);
    const accepted = new Map(objects);
    const foreign = encryptArtifact(objectPath, Buffer.from('different owner bytes'), 'text/plain');
    assert(foreign);
    assert.strictEqual(
      await storeEncryptedArtifact({ rootAgentId, objectPath, ...foreign, createOnly: true }),
      null
    );
    assert.deepStrictEqual(
      objects,
      accepted,
      'an unrelated existing object must never be adopted or overwritten'
    );
    assert.strictEqual(getActivePuts(), 0);
  }

  async function startListingFailureDoesNotPublishAnEmptyManifest() {
    objects.clear();
    const rootAgentId = 'offline-start-list-failure';
    const fixture = {
      rows: { Agent: [{ id: rootAgentId, isBenchmark: true, status: 'RUNNING' }] },
      agent_ids: [rootAgentId],
      user_id: 'offline-user',
      base_image: 'offline',
      captured_at: new Date().toISOString(),
    } as unknown as Parameters<typeof archiveAgentStartFixture>[1];
    sender.send = async (command) => {
      if (command?.constructor?.name === 'ListObjectsV2Command')
        throw new Error('offline listing transport refused');
      return interleavingSend(command);
    };
    try {
      await archiveAgentStartFixture(rootAgentId, fixture);
      assert(
        [...objects.keys()].some((key) => key.startsWith('trace-archive/' + rootAgentId + '/db/')),
        'start fixture must remain durable even when its listing is unavailable'
      );
      for (const objectPath of [
        'manifest.json.gz.enc',
        'manifest.json.gz.enc.meta.json',
        'manifest.public.json',
      ])
        assert(
          !objects.has('trace-archive/' + rootAgentId + '/' + objectPath),
          'unavailable listing must not publish an authoritative empty start manifest: ' +
            objectPath
        );
      assert.strictEqual(getActivePuts(), 0);
    } finally {
      sender.send = interleavingSend;
    }
  }

  async function localCreateOnlyPublishesOnlyCompleteFiles() {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-local-create-owning-'));
    await withEnv(
      { TRACE_ARCHIVE_BACKEND: 'local', TRACE_ARCHIVE_LOCAL_DIR: temporary },
      async () => {
        const rootAgentId = 'offline-local-atomic';
        const originalWrite = fs.writeFileSync;
        try {
          for (const sidecar of [false, true]) {
            const objectPath = sidecar ? 'sidecar.json.gz.enc' : 'body.json.gz.enc';
            const encrypted = encryptArtifact(
              objectPath,
              Buffer.from('owned complete bytes'),
              'text/plain'
            );
            assert(encrypted);
            const params = { rootAgentId, objectPath, ...encrypted, createOnly: true };
            const target = localObjectPath(rootAgentId, objectPath);
            const metadataBody = JSON.stringify(encrypted.metadata, null, 2);
            let partialWrites = 0;
            fs.writeFileSync = ((file, data, options) => {
              const matches = sidecar
                ? data === metadataBody
                : Buffer.isBuffer(data) && data.equals(encrypted.ciphertext);
              if (matches) {
                partialWrites++;
                originalWrite(
                  file,
                  (Buffer.isBuffer(data) ? data : Buffer.from(String(data))).subarray(0, 2),
                  options
                );
                throw Object.assign(new Error('offline partial native write refused'), {
                  code: 'ENOSPC',
                });
              }
              originalWrite(file, data, options);
            }) as typeof fs.writeFileSync;
            let failure: unknown;
            try {
              await storeEncryptedArtifact(params);
            } catch (error) {
              failure = error;
            } finally {
              fs.writeFileSync = originalWrite;
            }
            assert(
              failure instanceof Error &&
                failure.message.includes('offline partial native write refused'),
              'partial create-only writes must remain failures rather than existing-object no-ops'
            );
            assert.strictEqual(partialWrites, 5);
            const failedTarget = sidecar ? target + '.meta.json' : target;
            assert(!fs.existsSync(failedTarget), 'a failed write must leave no final destination');
            assert.deepStrictEqual(
              (await listArchivedObjects(rootAgentId)).map((item) => item.path),
              sidecar ? ['body.json.gz.enc', 'sidecar.json.gz.enc'] : [],
              'temporary staging files are never archive artifacts'
            );
            assert(
              await storeEncryptedArtifact(params),
              'same-input retry must publish a complete pair'
            );
            const stored = await readArchivedArtifact({ rootAgentId, objectPath });
            assert(stored);
            assert.strictEqual(
              decryptAndValidateArtifact(stored).toString(),
              'owned complete bytes'
            );
            const accepted = fs.readFileSync(target);
            const foreign = encryptArtifact(objectPath, Buffer.from('foreign bytes'), 'text/plain');
            assert(foreign);
            assert.strictEqual(
              await storeEncryptedArtifact({
                rootAgentId,
                objectPath,
                ...foreign,
                createOnly: true,
              }),
              null
            );
            assert.deepStrictEqual(fs.readFileSync(target), accepted);
          }
        } finally {
          fs.writeFileSync = originalWrite;
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      }
    )();
  }

  await test(
    'conditional creation preserves existing objects and rejects exhausted storage failures',
    conditionalCreationDistinguishesExistingObjectsFromFailure
  );
  await test(
    'conditional encrypted creation retries an accepted body sidecar into a readable pair',
    conditionalEncryptedCreationRetriesAcceptedBodySidecar
  );
  await test(
    'conditional encrypted creation repairs an earlier accepted body across calls',
    conditionalEncryptedCreationRepairsAnEarlierAcceptedBody
  );
  await test(
    'start listing failure skips empty authoritative manifests',
    startListingFailureDoesNotPublishAnEmptyManifest
  );
  await test(
    'local create-only body and sidecar publication is atomic',
    localCreateOnlyPublishesOnlyCompleteFiles
  );
}
