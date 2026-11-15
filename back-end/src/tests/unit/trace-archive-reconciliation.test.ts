#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveBytes,
  archiveJson,
  decryptAndValidateArtifact,
  readArchivedArtifact,
  storePlainArtifact,
} from '../../providers/traceArchive';
import {
  plainArchiveArtifactExists,
  readPlainArchivedArtifact,
} from '../../providers/traceArchiveStrict';
import {
  inspectFinalizedManifest,
  reconcileFinalizedManifest,
  TRACE_ARCHIVE_FINALIZING_MARKER,
} from '../../providers/traceArchiveManifest';
import { createTestHarness, withEnv } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('trace-archive reconciliation unit tests');

function artifactRef(ref: string, objectPath: string) {
  return {
    ref,
    path: objectPath,
    content_type: 'application/json',
    plaintext_bytes: null,
    ciphertext_bytes: null,
  };
}

async function seedStaleFinalizedBundle(
  rootAgentId: string,
  options: { includePublic?: boolean } = {}
): Promise<string> {
  const earlyPath = 'llm/early.json.gz.enc';
  const early = await archiveJson({ rootAgentId, objectPath: earlyPath, value: { early: true } });
  assert(early);
  const earlyRef = artifactRef(early.ref, earlyPath);
  await archiveJson({
    rootAgentId,
    objectPath: 'manifest.json.gz.enc',
    value: {
      schema_version: 1,
      root_agent_id: rootAgentId,
      benchmark_task_name: 'reconciliation-test',
      generated_at: new Date(0).toISOString(),
      artifact_count: 1,
      fixture_count: 0,
      provider_count: 0,
      media_count: 0,
      llm_trace_count: 1,
      artifacts: [earlyRef],
      world_model_mode: 'real',
      finalized: true,
      benchmark_result: { passed: true, status: 'PASSED', failure_reason: null },
      run: { root_goal: 'test convergence', root_status: 'COMPLETED' },
      correlations: { root_agent_id: rootAgentId, user_id: 'user-1', agent_ids: [rootAgentId] },
      sensitive: {
        artifact_refs: [earlyRef],
        fixture_refs: [],
        provider_refs: [],
        media_refs: [],
        llm_trace_refs: [earlyRef],
        force: false,
      },
    },
  });
  if (options.includePublic !== false) {
    await storePlainArtifact({
      rootAgentId,
      objectPath: 'manifest.public.json',
      body: Buffer.from(
        JSON.stringify({
          schema_version: 1,
          root_agent_id: rootAgentId,
          benchmark_task_name: 'reconciliation-test',
          generated_at: new Date(0).toISOString(),
          artifact_count: 1,
          fixture_count: 0,
          provider_count: 0,
          media_count: 0,
          llm_trace_count: 1,
          artifacts: [earlyRef],
        })
      ),
      contentType: 'application/json',
    });
  }
  return earlyPath;
}

async function main(): Promise<void> {
  await test(
    'late code/llm writes after the finalization fence reconcile the manifest automatically',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_PUBLIC_MANIFEST: 'true',
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-late-auto-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const rootAgentId = 'reconcile-late-auto';
        const earlyPath = await seedStaleFinalizedBundle(rootAgentId);
        // Finalization fence + current manifest, as after a real finalize.
        assert.strictEqual((await reconcileFinalizedManifest(rootAgentId)).status, 'current');
        const latePaths = [
          'code/session-1/0001/rollout.jsonl.gz.enc',
          'code/session-1/0002/rollout.jsonl.gz.enc',
          'llm-updates/late-1-chat.json.gz.enc',
        ];
        // A concurrent burst coalesces into bounded reconciliation passes.
        await Promise.all([
          archiveBytes({
            rootAgentId,
            objectPath: latePaths[0],
            body: Buffer.from('{"turn":1}'),
            contentType: 'application/json',
            createOnly: true,
          }),
          archiveBytes({
            rootAgentId,
            objectPath: latePaths[1],
            body: Buffer.from('{"turn":2}'),
            contentType: 'application/json',
          }),
          archiveJson({ rootAgentId, objectPath: latePaths[2], value: { late: true } }),
        ]);
        assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).status, 'current');
        const encrypted = await readArchivedArtifact({
          rootAgentId,
          objectPath: 'manifest.json.gz.enc',
        });
        assert(encrypted);
        const manifest = JSON.parse(decryptAndValidateArtifact(encrypted).toString('utf8')) as {
          artifacts: { path: string }[];
        };
        assert.deepStrictEqual(
          manifest.artifacts.map((artifact) => artifact.path).sort(),
          [earlyPath, ...latePaths].sort()
        );
      }
    )
  );
  await test(
    'late finalized artifact is added to encrypted and public manifests',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_PUBLIC_MANIFEST: 'true',
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-reconcile-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const rootAgentId = 'reconcile-root';
        const earlyPath = await seedStaleFinalizedBundle(rootAgentId);
        const latePath = 'llm/late.json.gz.enc';
        await archiveJson({ rootAgentId, objectPath: latePath, value: { late: true } });

        const before = await inspectFinalizedManifest(rootAgentId);
        assert.strictEqual(before.status, 'stale');
        assert.deepStrictEqual(before.missingFromEncrypted, [latePath]);
        assert.deepStrictEqual(before.missingFromPublic, [latePath]);

        const repaired = await reconcileFinalizedManifest(rootAgentId);
        assert.strictEqual(repaired.status, 'updated');
        assert.strictEqual(repaired.actualArtifactCount, 2);
        assert(
          await plainArchiveArtifactExists({
            rootAgentId,
            objectPath: TRACE_ARCHIVE_FINALIZING_MARKER,
          })
        );

        const encrypted = await readArchivedArtifact({
          rootAgentId,
          objectPath: 'manifest.json.gz.enc',
        });
        assert(encrypted);
        const manifest = JSON.parse(decryptAndValidateArtifact(encrypted).toString('utf8')) as {
          artifacts: { path: string }[];
          benchmark_result: { passed: boolean };
        };
        assert.deepStrictEqual(manifest.artifacts.map((artifact) => artifact.path).sort(), [
          earlyPath,
          latePath,
        ]);
        assert.strictEqual(manifest.benchmark_result.passed, true);

        const publicBody = await readPlainArchivedArtifact({
          rootAgentId,
          objectPath: 'manifest.public.json',
        });
        assert(publicBody);
        const publicManifest = JSON.parse(publicBody.toString('utf8')) as {
          artifacts: { path: string }[];
        };
        assert.deepStrictEqual(publicManifest.artifacts.map((artifact) => artifact.path).sort(), [
          earlyPath,
          latePath,
        ]);
        assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).status, 'current');
      }
    )
  );
  await test(
    'public-manifest-off reconciliation converges without creating a public manifest',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_PUBLIC_MANIFEST: 'false',
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-no-public-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const rootAgentId = 'reconcile-no-public';
        await seedStaleFinalizedBundle(rootAgentId, { includePublic: false });
        const latePath = 'llm/late.json.gz.enc';
        await archiveJson({ rootAgentId, objectPath: latePath, value: { late: true } });

        const before = await inspectFinalizedManifest(rootAgentId);
        assert.strictEqual(before.status, 'stale');
        assert.deepStrictEqual(before.missingFromEncrypted, [latePath]);
        assert.deepStrictEqual(before.missingFromPublic, []);
        assert.strictEqual((await reconcileFinalizedManifest(rootAgentId)).status, 'updated');
        assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).status, 'current');
        assert.strictEqual(
          await readPlainArchivedArtifact({ rootAgentId, objectPath: 'manifest.public.json' }),
          null
        );
      }
    )
  );
  await test(
    'production fake-r2 reconciliation uses its local fake store consistently',
    withEnv(
      {
        NODE_ENV: 'production',
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'fake-r2',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_PUBLIC_MANIFEST: 'true',
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-prod-fake-r2-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const rootAgentId = 'reconcile-prod-fake-r2';
        await seedStaleFinalizedBundle(rootAgentId);
        await archiveJson({
          rootAgentId,
          objectPath: 'llm/late.json.gz.enc',
          value: { late: true },
        });
        assert.strictEqual((await reconcileFinalizedManifest(rootAgentId)).status, 'updated');
        assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).status, 'current');
      }
    )
  );
}

main()
  .then(finish)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
