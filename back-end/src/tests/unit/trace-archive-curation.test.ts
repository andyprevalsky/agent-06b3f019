#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Unit tests for trace-archive curation: legacy migration and gold-bundle
 * classification (terminal status, fixtures, legacy markers, world-model mode).
 *
 * Split from trace-archive.test.ts (storage/encryption/lifecycle tests live there).
 *
 * Run: npx tsx src/tests/unit/trace-archive-curation.test.ts
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditArchiveBundle, listArchiveBundleIds } from '../../providers/traceArchiveAudit';
import {
  classifyTraceArchiveGold,
  curateTraceArchives,
} from '../../providers/traceArchiveCuration';
import { migrateLegacyTraces } from '../../providers/traceArchiveMigration';
import {
  archiveJson,
  deleteArchivedBundle,
  listArchivedObjects,
  storePlainArtifact,
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

const LOCAL_ARCHIVE_ENV = {
  TRACE_ARCHIVE_ENABLED: '1',
  TRACE_ARCHIVE_BACKEND: 'local',
  TRACE_ARCHIVE_LOCAL_DIR: undefined,
  TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
};

async function main(): Promise<void> {
  await test('curation rejects invalid concurrency before processing even empty inputs', async () => {
    for (const concurrency of [NaN, Infinity, -Infinity, 0, -1, 0.5]) {
      for (const rootAgentIds of [[], ['invalid-concurrency-must-not-touch-archive']]) {
        await assert.rejects(
          curateTraceArchives({ rootAgentIds, concurrency }),
          /concurrency must be a finite number greater than or equal to 1/
        );
      }
    }
    for (const concurrency of [undefined, 1, 1.9, 3]) {
      assert.deepStrictEqual(await curateTraceArchives({ rootAgentIds: [], concurrency }), []);
    }
  });

  await test(
    'legacy trace migration creates uniform bundles for benchmark and llm-only traces',
    withEnv(LOCAL_ARCHIVE_ENV, async () => {
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-trace-source-'));
      const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-trace-archive-'));
      process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveRoot;
      const runsDir = path.join(sourceRoot, 'agents', 'benchmarks', 'runs');
      const llmDir = path.join(sourceRoot, '.llm-dumps');
      fs.mkdirSync(runsDir, { recursive: true });
      fs.mkdirSync(path.join(llmDir, 'root-agent'), { recursive: true });
      fs.mkdirSync(path.join(llmDir, 'child-agent'), { recursive: true });
      fs.mkdirSync(path.join(llmDir, 'orphan-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(runsDir, 'legacy.json'),
        JSON.stringify({
          run_id: 'legacy-run',
          timestamp: '2026-07-03T12:00:00.000Z',
          tasks: [
            {
              name: 'legacy-task',
              agent_id: 'root-agent',
              status: 'COMPLETED',
              passed: true,
              logs: {
                messages: [
                  {
                    role: 'USER',
                    message: 'do the thing',
                    created_at: '2026-07-03T12:00:00.000Z',
                  },
                  {
                    role: 'TOOL',
                    message: 'spawned',
                    created_at: '2026-07-03T12:01:00.000Z',
                    metadata: {
                      toolName: 'spawn_general_purpose_agent',
                      toolCallId: 'tc-1',
                      subAgentId: 'child-agent',
                      toolStatus: 'FINISHED',
                    },
                  },
                ],
                realtime_logs: [],
              },
            },
          ],
        })
      );
      fs.writeFileSync(
        path.join(llmDir, 'root-agent', '1000-root.json'),
        JSON.stringify({ dump_id: 'root-dump', agent_id: 'root-agent', output: 'root' })
      );
      fs.writeFileSync(
        path.join(llmDir, 'child-agent', '1001-child.json'),
        JSON.stringify({ dump_id: 'child-dump', agent_id: 'child-agent', output: 'child' })
      );
      fs.writeFileSync(
        path.join(llmDir, 'orphan-agent', '1002-orphan.json'),
        JSON.stringify({ dump_id: 'orphan-dump', agent_id: 'orphan-agent', output: 'orphan' })
      );

      const summary = await migrateLegacyTraces({ sourceRoot, force: true });
      assert.strictEqual(summary.failed, 0);
      assert.strictEqual(summary.migrated, 2);
      assert.deepStrictEqual((await listArchiveBundleIds()).sort(), ['orphan-agent', 'root-agent']);

      const rootObjects = await listArchivedObjects('root-agent');
      assert.ok(rootObjects.some((object) => object.path === 'llm/root-dump.json.gz.enc'));
      assert.ok(rootObjects.some((object) => object.path === 'llm/child-dump.json.gz.enc'));
      assert.ok(
        rootObjects.some((object) => object.path === 'benchmark/legacy-run-legacy-task.json.gz.enc')
      );
      const rootAudit = await auditArchiveBundle('root-agent');
      assert.strictEqual(rootAudit.ok, true);
      assert.strictEqual(rootAudit.requiredObjects['db/start.fixture.json.gz.enc'], true);
      assert.strictEqual(rootAudit.requiredObjects['db/end.fixture.json.gz.enc'], true);

      const orphanObjects = await listArchivedObjects('orphan-agent');
      assert.ok(orphanObjects.some((object) => object.path === 'llm/orphan-dump.json.gz.enc'));
      const orphanAudit = await auditArchiveBundle('orphan-agent');
      assert.strictEqual(orphanAudit.ok, true);
    })
  );

  await test(
    'gold curation keeps real terminal bundles with fixtures and replayable artifacts',
    withEnv(LOCAL_ARCHIVE_ENV, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-gold-curation-'));
      process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
      const fixture = {
        schema_version: 1,
        kind: 'scoped-db-fixture',
        root_agent_id: 'gold-root',
        user_id: 'user-1',
        agent_ids: ['gold-root'],
        rows: { Agent: [{ id: 'gold-root', status: 'COMPLETED' }], User: [{ id: 'user-1' }] },
      };
      for (const objectPath of ['db/start.fixture.json.gz.enc', 'db/end.fixture.json.gz.enc']) {
        assert.ok(
          await archiveJson({
            rootAgentId: 'gold-root',
            objectPath,
            value: fixture,
          })
        );
      }
      assert.ok(
        await archiveJson({
          rootAgentId: 'gold-root',
          objectPath: 'provider/web/search-1.json.gz.enc',
          value: { request: { q: 'x' }, response: { ok: true } },
        })
      );
      assert.ok(
        await archiveJson({
          rootAgentId: 'gold-root',
          objectPath: 'manifest.json.gz.enc',
          value: {
            schema_version: 1,
            root_agent_id: 'gold-root',
            benchmark_task_name: 'gold-task',
            run: { root_status: 'COMPLETED' },
          },
        })
      );
      assert.ok(
        await storePlainArtifact({
          rootAgentId: 'gold-root',
          objectPath: 'manifest.public.json',
          body: Buffer.from('{"root_agent_id":"gold-root"}\n'),
          contentType: 'application/json',
        })
      );

      const classification = await classifyTraceArchiveGold('gold-root');
      assert.strictEqual(classification.gold, true);
      assert.deepStrictEqual(classification.reasons, []);
      assert.strictEqual(classification.replayableArtifactCount, 1);
      assert.strictEqual(classification.benchmarkTaskName, 'gold-task');
      // Legacy manifests without the marker predate simulation = real runs.
      assert.strictEqual(classification.worldModelMode, null);
    })
  );

  await test(
    'gold curation rejects world-model-simulated bundles but keeps shadow runs',
    withEnv(LOCAL_ARCHIVE_ENV, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-simulated-curation-'));
      process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
      const bundle = async (rootAgentId: string, worldModelMode: string) => {
        const fixture = {
          schema_version: 1,
          kind: 'scoped-db-fixture',
          root_agent_id: rootAgentId,
          user_id: 'user-1',
          agent_ids: [rootAgentId],
          rows: { Agent: [{ id: rootAgentId, status: 'COMPLETED' }], User: [{ id: 'user-1' }] },
        };
        for (const objectPath of ['db/start.fixture.json.gz.enc', 'db/end.fixture.json.gz.enc']) {
          assert.ok(await archiveJson({ rootAgentId, objectPath, value: fixture }));
        }
        assert.ok(
          await archiveJson({
            rootAgentId,
            objectPath: 'manifest.json.gz.enc',
            value: {
              schema_version: 1,
              root_agent_id: rootAgentId,
              benchmark_task_name: 'sim-task',
              world_model_mode: worldModelMode,
              run: { root_status: 'COMPLETED' },
            },
          })
        );
        assert.ok(
          await storePlainArtifact({
            rootAgentId,
            objectPath: 'manifest.public.json',
            body: Buffer.from(`{"root_agent_id":"${rootAgentId}"}\n`),
            contentType: 'application/json',
          })
        );
      };

      await bundle('sim-root', 'simulate');
      const simulated = await classifyTraceArchiveGold('sim-root');
      assert.strictEqual(simulated.gold, false);
      assert.ok(simulated.reasons.includes('simulated-run:simulate'));
      assert.strictEqual(simulated.worldModelMode, 'simulate');

      await bundle('shadow-root', 'shadow');
      const shadow = await classifyTraceArchiveGold('shadow-root');
      assert.strictEqual(shadow.gold, true);
      assert.strictEqual(shadow.worldModelMode, 'shadow');
    })
  );

  await test(
    'gold curation keeps complete terminal message-only bundles',
    withEnv(LOCAL_ARCHIVE_ENV, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-message-gold-'));
      process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
      const fixture = {
        schema_version: 1,
        kind: 'scoped-db-fixture',
        root_agent_id: 'message-root',
        user_id: 'user-1',
        agent_ids: ['message-root'],
        rows: {
          Agent: [{ id: 'message-root', status: 'ACTIVE' }],
          Message: [
            { id: 'msg-1', agentId: 'message-root', role: 'USER', text: 'hello' },
            { id: 'msg-2', agentId: 'message-root', role: 'ASSISTANT', text: 'hi' },
          ],
          User: [{ id: 'user-1' }],
        },
      };
      for (const objectPath of ['db/start.fixture.json.gz.enc', 'db/end.fixture.json.gz.enc']) {
        assert.ok(
          await archiveJson({
            rootAgentId: 'message-root',
            objectPath,
            value: fixture,
          })
        );
      }
      assert.ok(
        await archiveJson({
          rootAgentId: 'message-root',
          objectPath: 'manifest.json.gz.enc',
          value: {
            schema_version: 1,
            root_agent_id: 'message-root',
            source_kind: 'benchmark-task',
            benchmark_task_name: 'chat-mode',
            benchmark_result: { passed: true, status: 'PASSED', failure_reason: null },
            run: { root_status: 'ACTIVE' },
          },
        })
      );
      assert.ok(
        await storePlainArtifact({
          rootAgentId: 'message-root',
          objectPath: 'manifest.public.json',
          body: Buffer.from('{"root_agent_id":"message-root"}\n'),
          contentType: 'application/json',
        })
      );

      const classification = await classifyTraceArchiveGold('message-root');
      assert.strictEqual(classification.gold, true);
      assert.deepStrictEqual(classification.reasons, []);
      assert.strictEqual(classification.replayableArtifactCount, 0);
      assert.strictEqual(classification.rootStatus, 'PASSED');
    })
  );

  await test(
    'gold curation rejects and deletes legacy synthetic bundles',
    withEnv(LOCAL_ARCHIVE_ENV, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-curation-delete-'));
      process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
      const fixture = {
        schema_version: 1,
        kind: 'scoped-db-fixture',
        root_agent_id: 'legacy-root',
        user_id: 'legacy-user',
        agent_ids: ['legacy-root'],
        restore: { legacy_migrated: true },
        rows: { Agent: [{ id: 'legacy-root', status: 'COMPLETED' }] },
      };
      for (const objectPath of ['db/start.fixture.json.gz.enc', 'db/end.fixture.json.gz.enc']) {
        assert.ok(
          await archiveJson({
            rootAgentId: 'legacy-root',
            objectPath,
            value: fixture,
          })
        );
      }
      assert.ok(
        await archiveJson({
          rootAgentId: 'legacy-root',
          objectPath: 'llm/legacy.json.gz.enc',
          value: { kind: 'legacy-llm-dump', payload: { output: '' } },
        })
      );
      assert.ok(
        await archiveJson({
          rootAgentId: 'legacy-root',
          objectPath: 'manifest.json.gz.enc',
          value: {
            schema_version: 1,
            root_agent_id: 'legacy-root',
            legacy_migrated: true,
            source_kind: 'llm-only',
            run: { status: 'COMPLETED' },
          },
        })
      );
      assert.ok(
        await storePlainArtifact({
          rootAgentId: 'legacy-root',
          objectPath: 'manifest.public.json',
          body: Buffer.from('{"legacy_migrated":true}\n'),
          contentType: 'application/json',
        })
      );

      const dryRun = await curateTraceArchives({ rootAgentIds: ['legacy-root'] });
      assert.strictEqual(dryRun[0].classification.gold, false);
      assert.ok(dryRun[0].classification.reasons.includes('legacy-migrated'));
      assert.strictEqual(dryRun[0].deleted, false);
      assert.ok((await listArchivedObjects('legacy-root')).length > 0);

      // R2 is append-only: deletion without an explicit user request is refused
      // before anything is classified or removed.
      await assert.rejects(
        curateTraceArchives({ rootAgentIds: ['legacy-root'], deleteRejected: true }),
        /explicit user request/
      );
      await assert.rejects(
        deleteArchivedBundle('legacy-root', undefined as never),
        /explicit user request/
      );
      assert.ok((await listArchivedObjects('legacy-root')).length > 0);
      const deleted = await curateTraceArchives({
        rootAgentIds: ['legacy-root'],
        deleteRejected: true,
        userDeletionRequest: {
          userRequested: true,
          requestedBy: 'unit-test-user',
          reason: 'user asked to remove the legacy bundle',
        },
      });
      assert.strictEqual(deleted[0].deleted, true);
      assert.ok(deleted[0].deletedObjectCount >= 8);
      assert.deepStrictEqual(await listArchivedObjects('legacy-root'), []);
    })
  );

  await test(
    'curation runs classifications concurrently and preserves input order',
    withEnv(LOCAL_ARCHIVE_ENV, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-curation-concurrency-'));
      process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
      const roots = ['conc-a', 'conc-b', 'conc-c', 'conc-d', 'conc-e'];
      for (const rootAgentId of roots) {
        const fixture = {
          schema_version: 1,
          kind: 'scoped-db-fixture',
          root_agent_id: rootAgentId,
          user_id: 'conc-user',
          agent_ids: [rootAgentId],
          rows: { Agent: [{ id: rootAgentId, status: 'COMPLETED' }] },
        };
        for (const objectPath of ['db/start.fixture.json.gz.enc', 'db/end.fixture.json.gz.enc']) {
          assert.ok(await archiveJson({ rootAgentId, objectPath, value: fixture }));
        }
        assert.ok(
          await archiveJson({
            rootAgentId,
            objectPath: 'manifest.json.gz.enc',
            value: { schema_version: 1, root_agent_id: rootAgentId, run: { status: 'COMPLETED' } },
          })
        );
        assert.ok(
          await storePlainArtifact({
            rootAgentId,
            objectPath: 'manifest.public.json',
            body: Buffer.from(`{"root_agent_id":"${rootAgentId}"}\n`),
            contentType: 'application/json',
          })
        );
      }
      const seen: number[] = [];
      const results = await curateTraceArchives({
        rootAgentIds: roots,
        concurrency: 3,
        onResult: (_result, index) => seen.push(index),
      });
      assert.deepStrictEqual(
        results.map((result) => result.classification.rootAgentId),
        roots
      );
      assert.deepStrictEqual(
        [...seen].sort((a, b) => a - b),
        [0, 1, 2, 3, 4]
      );
      for (const result of results) {
        assert.strictEqual(result.deleted, false);
        assert.strictEqual(
          result.classification.gold,
          true,
          JSON.stringify(result.classification.reasons)
        );
      }
    })
  );

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`\ntrace-archive curation unit tests: ${passed} passed`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
