/* eslint-disable no-console */

/**
 * The bundle manifest is written at agent creation (not only at finalize), so a
 * run that crashes or is SIGKILLed before it can finalize still has a
 * classifiable, world-model-ingestible bundle. The world model gates eligibility
 * on a present manifest carrying a `world_model_mode`; a missing manifest reads
 * as "unknown" and the whole run is silently dropped. These tests pin that the
 * manifest exists from start and that only the root agent owns it.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptAndValidateArtifact, readArchivedArtifact } from '../../providers/traceArchive';
import { archiveAgentStartFixture } from '../../providers/traceArchiveLifecycle';
import { createTestHarness, withEnv } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('trace-archive manifest-at-creation unit tests');

function startFixture(
  rootAgentId: string,
  agentIds: string[],
  isBenchmark = false
): Parameters<typeof archiveAgentStartFixture>[1] {
  return {
    schema_version: 1,
    kind: 'scoped-db-fixture',
    phase: 'start',
    captured_at: new Date(0).toISOString(),
    base_image: 'base:test',
    root_agent_id: rootAgentId,
    user_id: 'user-1',
    agent_ids: agentIds,
    table_order: [],
    restore: { strategy: 'noop', scope: {} },
    rows: {
      Agent: [
        {
          id: rootAgentId,
          goal: 'do a thing',
          status: 'STARTING_UP',
          isBenchmark,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
    },
  } as unknown as Parameters<typeof archiveAgentStartFixture>[1];
}

async function main(): Promise<void> {
  await test(
    'agent start writes a classifiable manifest; sub-agents do not own one',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_PUBLIC_MANIFEST: 'false',
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-start-manifest-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;

        // Root agent: the manifest exists from creation so a run that never
        // finalizes is still a classifiable, ingestible bundle.
        const rootId = 'start-root';
        await archiveAgentStartFixture(rootId, startFixture(rootId, [rootId]));
        const rootManifest = await readArchivedArtifact({
          rootAgentId: rootId,
          objectPath: 'manifest.json.gz.enc',
        });
        assert.ok(rootManifest, 'root start must write manifest.json.gz.enc');
        const parsed = JSON.parse(decryptAndValidateArtifact(rootManifest).toString('utf8')) as {
          world_model_mode: string;
          finalized: boolean;
          correlations: { root_agent_id: string; agent_ids: string[] };
        };
        assert.strictEqual(parsed.world_model_mode, 'real');
        assert.strictEqual(parsed.finalized, false);
        assert.strictEqual(parsed.correlations.root_agent_id, rootId);
        assert.deepStrictEqual(parsed.correlations.agent_ids, [rootId]);

        // Sub-agent (agentId !== agent_ids[0]): the bundle manifest is owned by
        // the root, so no separate manifest is written under the sub-agent id.
        const subId = 'start-sub';
        await archiveAgentStartFixture(subId, startFixture(rootId, [rootId, subId]));
        const subManifest = await readArchivedArtifact({
          rootAgentId: subId,
          objectPath: 'manifest.json.gz.enc',
        });
        assert.strictEqual(subManifest, null, 'sub-agent must not own a bundle manifest');
      }
    )
  );

  await test(
    'a benchmark run is marked non-eligible (pending) at start, not real',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_ENCRYPTION_KEY_B64: undefined,
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
        TRACE_ARCHIVE_PUBLIC_MANIFEST: 'false',
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-bench-manifest-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;

        // A benchmark run can be shadow/simulate; its true mode is only known at
        // finalize. If it crashes first, the creation manifest must NOT read as
        // real — otherwise a simulate run would poison the real-world corpus.
        const benchId = 'bench-root';
        await archiveAgentStartFixture(benchId, startFixture(benchId, [benchId], true));
        const stored = await readArchivedArtifact({
          rootAgentId: benchId,
          objectPath: 'manifest.json.gz.enc',
        });
        assert.ok(stored, 'benchmark start must still write a manifest');
        const parsed = JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as {
          world_model_mode: string;
          finalized: boolean;
        };
        assert.strictEqual(
          parsed.world_model_mode,
          'pending',
          'benchmark start manifest must be non-real (pending), not real'
        );
        assert.notStrictEqual(parsed.world_model_mode, 'real');
        assert.strictEqual(parsed.finalized, false);
      }
    )
  );
}

main()
  .then(finish)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
