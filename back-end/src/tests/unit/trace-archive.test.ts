#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { S3Client } from '@aws-sdk/client-s3';
import {
  archiveBytes,
  archiveJson,
  decryptAndValidateArtifact,
  encryptArtifact,
  listArchivedObjects,
  readArchivedArtifact,
  type EncryptedArtifactMetadata,
} from '../../providers/traceArchive';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function withEnv(values: Record<string, string | undefined>, fn: () => void | Promise<void>) {
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

function decrypt(ciphertext: Buffer, metadata: EncryptedArtifactMetadata, key?: Buffer): Buffer {
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

function bodyToBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  throw new Error(`Unsupported test S3 body type: ${typeof body}`);
}

async function main(): Promise<void> {
  await test(
    'gzip-before-encrypt JSON roundtrip records hashes',
    withEnv(
      { NODE_ENV: 'test', ENVIRONMENT: undefined, TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined },
      () => {
        const body = Buffer.from(JSON.stringify({ hello: 'world' }));
        const encrypted = encryptArtifact('llm/demo.json.gz.enc', body, 'application/json');
        assert.ok(encrypted);
        assert.strictEqual(encrypted.metadata.compression, 'gzip');
        assert.strictEqual(
          encrypted.metadata.plaintext_sha256,
          crypto.createHash('sha256').update(body).digest('hex')
        );
        assert.strictEqual(
          encrypted.metadata.ciphertext_sha256,
          crypto.createHash('sha256').update(encrypted.ciphertext).digest('hex')
        );
        assert.deepStrictEqual(
          JSON.parse(decrypt(encrypted.ciphertext, encrypted.metadata).toString()),
          {
            hello: 'world',
          }
        );
      }
    )
  );

  await test(
    'media artifacts skip gzip',
    withEnv(
      { NODE_ENV: 'test', ENVIRONMENT: undefined, TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined },
      () => {
        const body = Buffer.from('\x00\x00\x00\x18ftypmp42already-compressed');
        const encrypted = encryptArtifact('media/browser/demo.mp4', body, 'video/mp4');
        assert.ok(encrypted);
        assert.strictEqual(encrypted.metadata.compression, 'none');
        assert.deepStrictEqual(decrypt(encrypted.ciphertext, encrypted.metadata), body);
      }
    )
  );

  await test(
    'local backend writes encrypted object plus metadata',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const result = await archiveJson({
          rootAgentId: 'agent-1',
          objectPath: 'manifest.json.gz.enc',
          value: { ok: true },
        });
        assert.ok(result);
        assert.ok(fs.existsSync(result.ref));
        assert.ok(fs.existsSync(`${result.ref}.meta.json`));
        assert.deepStrictEqual(
          JSON.parse(decrypt(fs.readFileSync(result.ref), result.metadata).toString()),
          {
            ok: true,
          }
        );
        const listed = await listArchivedObjects('agent-1');
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0].path, 'manifest.json.gz.enc');
        assert.strictEqual(
          (listed[0].metadata as EncryptedArtifactMetadata).plaintext_sha256,
          result.metadata.plaintext_sha256
        );
      }
    )
  );

  await test(
    'gold storage I/O validates byte-perfect local roundtrip',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-gold-local-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const body = Buffer.from(
          '{"kind":"gold","rows":[{"id":"row-1","value":"exact"}]}\n',
          'utf8'
        );
        const result = await archiveBytes({
          rootAgentId: 'gold-agent',
          objectPath: 'db/gold.fixture.json.gz.enc',
          body,
          contentType: 'application/json',
        });
        assert.ok(result);
        const stored = await readArchivedArtifact({
          rootAgentId: 'gold-agent',
          objectPath: 'db/gold.fixture.json.gz.enc',
        });
        assert.ok(stored);
        assert.deepStrictEqual(stored.metadata, result.metadata);
        const recovered = decryptAndValidateArtifact(stored);
        assert.deepStrictEqual(recovered, body);
        assert.notDeepStrictEqual(stored.ciphertext, body);
      }
    )
  );

  await test(
    'gold storage I/O detects ciphertext tampering before returning plaintext',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-gold-tamper-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const result = await archiveJson({
          rootAgentId: 'tamper-agent',
          objectPath: 'llm/tamper.json.gz.enc',
          value: { exact: true },
        });
        assert.ok(result);
        const stored = await readArchivedArtifact({
          rootAgentId: 'tamper-agent',
          objectPath: 'llm/tamper.json.gz.enc',
        });
        assert.ok(stored);
        const tampered = Buffer.from(stored.ciphertext);
        tampered[0] ^= 0xff;
        assert.throws(
          () => decryptAndValidateArtifact({ ciphertext: tampered, metadata: stored.metadata }),
          /ciphertext SHA-256 mismatch/
        );
      }
    )
  );

  await test(
    'simulated prod local backend requires configured key and roundtrips',
    withEnv(
      {
        NODE_ENV: 'production',
        ENVIRONMENT: 'production',
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
      },
      async () => {
        const key = Buffer.alloc(32, 7);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-prod-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const result = await archiveJson({
          rootAgentId: 'prod-agent',
          objectPath: 'llm/prod.json.gz.enc',
          value: { prod: true },
        });
        assert.ok(result);
        assert.deepStrictEqual(
          JSON.parse(decrypt(fs.readFileSync(result.ref), result.metadata, key).toString()),
          { prod: true }
        );
      }
    )
  );

  await test(
    'fake R2 backend stores locally but returns r2 refs for tests',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'fake-r2',
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-fake-r2-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const result = await archiveJson({
          rootAgentId: 'agent-r2',
          objectPath: 'provider/web/result.json.gz.enc',
          value: { ok: 'r2' },
        });
        assert.ok(result);
        assert(result.ref.startsWith('r2://fake-trace-archive/trace-archive/agent-r2/'));
        const localPath = path.join(
          dir,
          'trace-archive',
          'agent-r2',
          'provider',
          'web',
          'result.json.gz.enc'
        );
        assert.ok(fs.existsSync(localPath));
        const listed = await listArchivedObjects('agent-r2');
        assert.strictEqual(listed[0].ref, result.ref);
        const stored = await readArchivedArtifact({
          rootAgentId: 'agent-r2',
          objectPath: 'provider/web/result.json.gz.enc',
        });
        assert.ok(stored);
        assert.deepStrictEqual(JSON.parse(decryptAndValidateArtifact(stored).toString()), {
          ok: 'r2',
        });
      }
    )
  );

  await test(
    'R2 backend uses S3 put/get/list and validates byte-perfect roundtrip',
    withEnv(
      {
        NODE_ENV: 'production',
        ENVIRONMENT: 'production',
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'r2',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: Buffer.alloc(32, 9).toString('base64'),
        R2_ACCOUNT_ID: 'unit-account',
        R2_ACCESS_KEY_ID: 'unit-access',
        R2_SECRET_ACCESS_KEY: 'unit-secret',
        R2_BUCKET_TRACE_ARCHIVE: 'unit-trace-bucket',
      },
      async () => {
        const originalSend = (
          S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> }
        ).send;
        const objects = new Map<
          string,
          { body: Buffer; contentType: string; serverSideEncryption?: string }
        >();
        const sentCommands: string[] = [];
        (S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> }).send =
          async (command: unknown) => {
            const commandName = command?.constructor?.name;
            sentCommands.push(String(commandName));
            const input = (command as { input?: Record<string, unknown> }).input ?? {};
            if (commandName === 'PutObjectCommand') {
              assert.strictEqual(input.Bucket, 'unit-trace-bucket');
              assert.strictEqual(input.ServerSideEncryption, 'AES256');
              objects.set(String(input.Key), {
                body: bodyToBuffer(input.Body),
                contentType: String(input.ContentType),
                serverSideEncryption: String(input.ServerSideEncryption),
              });
              return {};
            }
            if (commandName === 'GetObjectCommand') {
              assert.strictEqual(input.Bucket, 'unit-trace-bucket');
              const stored = objects.get(String(input.Key));
              if (stored === undefined) throw new Error(`missing object ${String(input.Key)}`);
              return { Body: stored.body };
            }
            if (commandName === 'ListObjectsV2Command') {
              assert.strictEqual(input.Bucket, 'unit-trace-bucket');
              const prefix = String(input.Prefix ?? '');
              return {
                Contents: [...objects.keys()]
                  .filter((key) => key.startsWith(prefix))
                  .sort()
                  .map((Key) => ({ Key })),
              };
            }
            throw new Error(`unexpected S3 command ${String(commandName)}`);
          };
        try {
          const body = Buffer.from('{"prod":"r2","exact":true}\n', 'utf8');
          const result = await archiveBytes({
            rootAgentId: 'prod-r2-agent',
            objectPath: 'llm/prod-r2.json.gz.enc',
            body,
            contentType: 'application/json',
          });
          assert.ok(result);
          assert.strictEqual(
            result.ref,
            'r2://unit-trace-bucket/trace-archive/prod-r2-agent/llm/prod-r2.json.gz.enc'
          );
          const object = objects.get('trace-archive/prod-r2-agent/llm/prod-r2.json.gz.enc');
          const metadataObject = objects.get(
            'trace-archive/prod-r2-agent/llm/prod-r2.json.gz.enc.meta.json'
          );
          assert.ok(object);
          assert.ok(metadataObject);
          assert.strictEqual(object.serverSideEncryption, 'AES256');
          assert.strictEqual(metadataObject.contentType, 'application/json');
          const stored = await readArchivedArtifact({
            rootAgentId: 'prod-r2-agent',
            objectPath: 'llm/prod-r2.json.gz.enc',
          });
          assert.ok(stored);
          assert.deepStrictEqual(stored.metadata, result.metadata);
          assert.deepStrictEqual(decryptAndValidateArtifact(stored), body);
          const listed = await listArchivedObjects('prod-r2-agent');
          assert.deepStrictEqual(
            listed.map((item) => item.path),
            ['llm/prod-r2.json.gz.enc']
          );
          assert.deepStrictEqual(sentCommands.sort(), [
            'GetObjectCommand',
            'GetObjectCommand',
            'ListObjectsV2Command',
            'PutObjectCommand',
            'PutObjectCommand',
          ]);
        } finally {
          (S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> }).send =
            originalSend;
        }
      }
    )
  );

  await test(
    'missing prod encryption key disables encryption without throwing',
    withEnv(
      {
        NODE_ENV: 'production',
        ENVIRONMENT: 'production',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
      },
      () => {
        const encrypted = encryptArtifact(
          'llm/prod.json.gz.enc',
          Buffer.from('{}'),
          'application/json'
        );
        assert.strictEqual(encrypted, null);
      }
    )
  );

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`\ntrace-archive unit tests: ${passed} passed`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
