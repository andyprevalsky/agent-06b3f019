#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { auditArchiveBundle, listArchiveBundleIds } from '../../providers/traceArchiveAudit';
import { assertArchiveFinalizable } from '../../providers/traceArchiveLifecycle';
import {
  archiveBytes,
  archiveJson,
  decryptAndValidateArtifact,
  encryptArtifact,
  listArchivedObjects,
  readArchivedArtifact,
  storePlainArtifact,
  type EncryptedArtifactMetadata,
  validateEncryptedArtifactEnvelope,
} from '../../providers/traceArchive';
import { bodyToBuffer, createTestHarness, decrypt, withEnv } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('trace-archive unit tests');

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
    'worker artifact envelope validation rejects incomplete or mismatched metadata',
    withEnv(
      { NODE_ENV: 'test', ENVIRONMENT: undefined, TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined },
      () => {
        const encrypted = encryptArtifact(
          'llm/validated.json.gz.enc',
          Buffer.from('{"ok":true}'),
          'application/json'
        );
        assert.ok(encrypted);
        assert.deepStrictEqual(
          validateEncryptedArtifactEnvelope({
            objectPath: 'llm/validated.json.gz.enc',
            ciphertext: encrypted.ciphertext,
            metadata: encrypted.metadata,
          }),
          encrypted.metadata
        );
        assert.throws(
          () =>
            validateEncryptedArtifactEnvelope({
              objectPath: 'llm/validated.json.gz.enc',
              ciphertext: encrypted.ciphertext,
              metadata: { path: 'llm/validated.json.gz.enc' },
            }),
          /Archive metadata missing/
        );
        assert.throws(
          () =>
            validateEncryptedArtifactEnvelope({
              objectPath: 'llm/other.json.gz.enc',
              ciphertext: encrypted.ciphertext,
              metadata: encrypted.metadata,
            }),
          /path mismatch/
        );
      }
    )
  );

  await test(
    'archive audit validates required fixtures manifest and encrypted object integrity',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-audit-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        for (const objectPath of [
          'db/start.fixture.json.gz.enc',
          'db/end.fixture.json.gz.enc',
          'manifest.json.gz.enc',
        ]) {
          const result = await archiveJson({
            rootAgentId: 'audit-agent',
            objectPath,
            value: { objectPath, ok: true },
          });
          assert.ok(result);
        }
        const publicRef = await storePlainArtifact({
          rootAgentId: 'audit-agent',
          objectPath: 'manifest.public.json',
          body: Buffer.from('{"ok":true}\n'),
          contentType: 'application/json',
        });
        assert.ok(publicRef);
        assert.deepStrictEqual(await listArchiveBundleIds(), ['audit-agent']);
        const audit = await auditArchiveBundle('audit-agent');
        assert.strictEqual(audit.ok, true);
        assert.strictEqual(audit.objectCount, 4);
        assert.strictEqual(audit.encryptedObjectCount, 3);
        assert.strictEqual(audit.decryptedObjectCount, 3);
        assert.deepStrictEqual(audit.missing, []);
        assert.deepStrictEqual(audit.invalid, []);
      }
    )
  );

  await test('archive finalization refuses unforced active root manifests', () => {
    const fixture = {
      rows: {
        Agent: [{ id: 'active-root', status: 'ACTIVE' }],
      },
      agent_ids: ['active-root'],
    };
    assert.throws(
      () => assertArchiveFinalizable({ rootAgentId: 'active-root' }, fixture),
      /requires a terminal status.*ACTIVE/
    );
    assert.doesNotThrow(() =>
      assertArchiveFinalizable({ rootAgentId: 'active-root', benchmarkStatus: 'PASSED' }, fixture)
    );
    assert.doesNotThrow(() =>
      assertArchiveFinalizable({ rootAgentId: 'active-root', force: true }, fixture)
    );
  });

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
    'archive listing returns empty when disabled',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '0',
        TRACE_ARCHIVE_BACKEND: 'local',
      },
      async () => {
        assert.deepStrictEqual(await listArchivedObjects('disabled-agent'), []);
      }
    )
  );

  await test(
    'local listing tolerates corrupt metadata sidecars',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-corrupt-meta-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const objectDir = path.join(dir, 'trace-archive', 'agent-corrupt-meta', 'provider', 'sms');
        fs.mkdirSync(objectDir, { recursive: true });
        const objectPath = path.join(objectDir, 'bad.json.gz.enc');
        fs.writeFileSync(objectPath, Buffer.from('not-real-ciphertext'));
        fs.writeFileSync(`${objectPath}.meta.json`, '{not valid json');

        const listed = await listArchivedObjects('agent-corrupt-meta');
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0].path, 'provider/sms/bad.json.gz.enc');
        assert.strictEqual(listed[0].metadata, undefined);
      }
    )
  );

  await test(
    'local read returns null for absent artifact',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-missing-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const stored = await readArchivedArtifact({
          rootAgentId: 'missing-agent',
          objectPath: 'provider/sms/missing.json.gz.enc',
        });
        assert.strictEqual(stored, null);
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
              if (input.Delimiter === '/') {
                return {
                  CommonPrefixes: [...objects.keys()]
                    .filter((key) => key.startsWith(prefix))
                    .map((key) => key.slice(prefix.length).split('/')[0])
                    .filter((id, index, ids) => id !== '' && ids.indexOf(id) === index)
                    .sort()
                    .map((id) => ({ Prefix: `${prefix}${id}/` })),
                };
              }
              return {
                Contents: [...objects.keys()]
                  .filter((key) => key.startsWith(prefix))
                  .sort()
                  .map((Key) => ({ Key })),
              };
            }
            if (commandName === 'HeadObjectCommand') {
              // Late-write fence probe: this bundle has no finalization marker.
              assert.strictEqual(input.Bucket, 'unit-trace-bucket');
              if (objects.has(String(input.Key))) return {};
              throw Object.assign(new Error('NotFound'), {
                name: 'NotFound',
                $metadata: { httpStatusCode: 404 },
              });
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
          assert.deepStrictEqual(await listArchiveBundleIds(), ['prod-r2-agent']);
          assert.deepStrictEqual(sentCommands.sort(), [
            'GetObjectCommand',
            'GetObjectCommand',
            // llm/ writes probe the root's finalization fence (late-write reconciliation).
            'HeadObjectCommand',
            'ListObjectsV2Command',
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
    'R2 backend retries transient TLS write failures with a fresh S3 client',
    withEnv(
      {
        NODE_ENV: 'production',
        ENVIRONMENT: 'production',
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'r2',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: Buffer.alloc(32, 11).toString('base64'),
        R2_ACCOUNT_ID: 'retry-account',
        R2_ACCESS_KEY_ID: 'retry-access',
        R2_SECRET_ACCESS_KEY: 'retry-secret',
        R2_BUCKET_TRACE_ARCHIVE: 'retry-trace-bucket',
      },
      async () => {
        const originalSend = (
          S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> }
        ).send;
        const clients = new Set<unknown>();
        let putAttempts = 0;
        const objects = new Map<string, Buffer>();
        (S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> }).send =
          async function send(command: unknown) {
            clients.add(this);
            const commandName = command?.constructor?.name;
            const input = (command as { input?: Record<string, unknown> }).input ?? {};
            if (commandName !== 'PutObjectCommand') {
              throw new Error(`unexpected S3 command ${String(commandName)}`);
            }
            putAttempts += 1;
            if (putAttempts === 1) {
              throw new Error('ssl3_read_bytes:sslv3 alert bad record mac');
            }
            assert.strictEqual(input.Bucket, 'retry-trace-bucket');
            objects.set(String(input.Key), bodyToBuffer(input.Body));
            return {};
          };
        try {
          const result = await archiveBytes({
            rootAgentId: 'retry-r2-agent',
            objectPath: 'db/end.fixture.json.gz.enc',
            body: Buffer.from('{"retry":true}\n', 'utf8'),
            contentType: 'application/json',
          });
          assert.ok(result);
          assert.strictEqual(putAttempts, 3);
          assert(
            clients.size >= 2,
            'retry after a TLS transport failure must recreate the cached S3 client'
          );
          assert(objects.has('trace-archive/retry-r2-agent/db/end.fixture.json.gz.enc'));
          assert(objects.has('trace-archive/retry-r2-agent/db/end.fixture.json.gz.enc.meta.json'));
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

  finish();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
