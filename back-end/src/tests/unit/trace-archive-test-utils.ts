/* eslint-disable no-console */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { EncryptedArtifactMetadata } from '../../providers/traceArchive';

export function createTestHarness(label: string): {
  test: (name: string, fn: () => void | Promise<void>) => Promise<void>;
  finish: () => void;
} {
  let passed = 0;
  const failures: string[] = [];
  return {
    async test(name: string, fn: () => void | Promise<void>): Promise<void> {
      try {
        await fn();
        passed += 1;
        console.log(`  ✅ ${name}`);
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        console.log(`  ❌ ${name}`);
      }
    },
    finish(): void {
      if (failures.length > 0) {
        console.error('\nFailures:');
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exit(1);
      }
      console.log(`\n${label}: ${passed} passed`);
    },
  };
}

export function withEnv(
  values: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): () => Promise<void> {
  return async () => {
    const old: Record<string, string | undefined> = {};
    for (const key of Object.keys(values)) old[key] = process.env[key];
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fn();
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

export function decrypt(
  ciphertext: Buffer,
  metadata: EncryptedArtifactMetadata,
  key?: Buffer
): Buffer {
  const archiveKey =
    key ?? crypto.createHash('sha256').update('rose-trace-archive-dev-key').digest();
  const tag = Buffer.from(metadata.auth_tag_b64, 'base64');
  const encrypted = ciphertext.subarray(0, ciphertext.length - tag.length);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    archiveKey,
    Buffer.from(metadata.nonce_b64, 'base64')
  );
  decipher.setAAD(Buffer.from(metadata.aad, 'utf8'));
  decipher.setAuthTag(tag);
  const stored = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return metadata.compression === 'gzip' ? zlib.gunzipSync(stored) : stored;
}

export function bodyToBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  throw new Error(`Unsupported test S3 body type: ${typeof body}`);
}
