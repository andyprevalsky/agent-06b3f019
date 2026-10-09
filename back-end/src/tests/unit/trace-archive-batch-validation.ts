import assert from 'node:assert';
import { S3Client } from '@aws-sdk/client-s3';
import { decryptAndValidateArtifact, encryptArtifact } from '../../providers/traceArchive';
import {
  ARCHIVE_BATCH_MAX_BYTES,
  storeWorkerArtifacts,
} from '../../providers/traceArchiveLifecycle';
import { bodyToBuffer } from './trace-archive-test-utils';

export async function boundedBatchValidation(): Promise<void> {
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
        if (String(input.Key).endsWith(failPath ?? '\\0')) throw new Error('fixture store refused');
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
}
