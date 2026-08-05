#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import {
  resolveActiveWorkspaces,
  terminateStaleWorkflowsWithClient,
  type CleanupWorkflowClient,
} from '../../../scripts/cleanup-stale-workspaces';

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
    throw error;
  }
}

/** Records which workflows the cleanup actually terminated. */
function fakeTemporal(workflows: Array<{ workflowId: string; taskQueue: string }>): {
  client: CleanupWorkflowClient;
  terminatedIds: string[];
} {
  const terminatedIds: string[] = [];
  const client: CleanupWorkflowClient = {
    workflow: {
      list: () =>
        (async function* () {
          for (const wf of workflows) yield { ...wf, runId: `${wf.workflowId}-run` };
        })(),
      getHandle: (workflowId: string) => ({
        terminate: async (_reason: string) => {
          terminatedIds.push(workflowId);
        },
      }),
    },
  };
  return { client, terminatedIds };
}

/**
 * Conductor stub: the first query resolves the repository id, every later query
 * returns the given `directory|secondary|state` rows.
 */
function oneRepoThen(...rows: string[]): (query: string) => string {
  let queryCount = 0;
  return () => {
    queryCount += 1;
    return queryCount === 1 ? 'repo-rose' : rows.join('\n');
  };
}

// ── Workspace identity resolution ──

const IDENTITY_CASES: Array<{ name: string; run: () => void }> = [
  {
    name: 'keeps directory and secondary workspace identities active',
    run: () => {
      const queries: string[] = [];
      const active = resolveActiveWorkspaces('fix-query-input-controls', (query) => {
        queries.push(query);
        if (queries.length === 1) return 'repo-rose';
        return [
          'raleigh|fix-query-input-controls|running',
          'san-jose|sms-onboarding|stopped',
          'old-town|legacy-alias|archived',
        ].join('\n');
      });

      assert.equal(active.repositoryId, 'repo-rose');
      assert.deepEqual(active.directoryNames, new Set(['raleigh', 'san-jose']));
      assert.deepEqual(
        active.resourceNames,
        new Set(['raleigh', 'fix-query-input-controls', 'san-jose', 'sms-onboarding'])
      );
      assert.deepEqual(active.archivedDirectoryNames, new Set(['old-town']));
      assert.deepEqual(active.archivedResourceNames, new Set(['old-town', 'legacy-alias']));
      assert.match(queries[0], /SELECT DISTINCT repository_id/);
      assert.match(queries[1], /WHERE repository_id = 'repo-rose'/);
    },
  },
  {
    name: 'an identity reused by an active workspace is never eligible for cleanup',
    run: () => {
      const active = resolveActiveWorkspaces(
        'raleigh',
        oneRepoThen('raleigh|shared-alias|running', 'old-town|shared-alias|archived')
      );

      assert.ok(active.resourceNames.has('shared-alias'));
      assert.equal(active.archivedResourceNames.has('shared-alias'), false);
    },
  },
  {
    name: 'an archived directory colliding with an active secondary alias is never destroyable',
    run: () => {
      // `killOrphanedProcesses` SIGKILLs on archivedDirectoryNames, so an
      // archived directory_name that an ACTIVE workspace claims as its alias
      // must be excluded from BOTH archived sets, not just the resource set.
      const active = resolveActiveWorkspaces(
        'raleigh',
        oneRepoThen('raleigh|old-town|running', 'old-town|legacy-alias|archived')
      );

      assert.equal(active.archivedDirectoryNames.has('old-town'), false);
      assert.equal(active.archivedResourceNames.has('old-town'), false);
    },
  },
];

const FAILURE_CASES: Array<{ name: string; run: () => void }> = [
  {
    name: 'fails closed when the current workspace has no repository match',
    run: () =>
      assert.throws(
        () => resolveActiveWorkspaces('missing-workspace', () => ''),
        /Could not resolve a Conductor repository/
      ),
  },
  {
    name: 'fails closed when the current workspace matches multiple repositories',
    run: () =>
      assert.throws(
        () => resolveActiveWorkspaces('ambiguous-workspace', () => 'repo-one\nrepo-two'),
        /matched multiple Conductor repositories/
      ),
  },
  {
    name: 'fails closed when the repository has no active workspace identities',
    run: () =>
      assert.throws(
        () => resolveActiveWorkspaces('raleigh', oneRepoThen()),
        /No active Conductor workspaces found/
      ),
  },
  {
    name: 'fails closed when one active identity belongs to multiple workspaces',
    run: () =>
      assert.throws(
        () =>
          resolveActiveWorkspaces(
            'raleigh',
            oneRepoThen('raleigh|shared-name|running', 'san-jose|shared-name|running')
          ),
        /Active Conductor identity shared-name is ambiguous/
      ),
  },
];

// ── Queue disposition ──
//
// Regression for the 2026-08-03 incident: a local `/deploy` Step 11a cleanup run
// terminated 16 LIVE PRODUCTION agent workflows with
// "Deploy cleanup: stale workspace workflow". Production workers poll
// generation-scoped queues (`navi-agent-tasks@<surfaceHash>`, see
// agents/helpers/worker_generation.py), which match neither the exact-equality
// prod guard nor the `navi-agent-tasks-` workspace prefix, so every prod
// workflow fell through to the unconditional "stale or unknown — terminate"
// branch. Cleanup must only ever terminate a queue it can positively attribute
// to an archived Conductor workspace.

// `test` is deliberately in the archived set: an archived Conductor workspace
// really does carry the secondary alias "test", which collides with the shared
// e2e queue `navi-agent-tasks-test`.
const WORKSPACES = { archivedResourceNames: new Set(['deleted-workspace', 'old-town', 'test']) };

type Workflow = { workflowId: string; taskQueue: string };

async function terminatedFor(workflows: Workflow[]): Promise<string[]> {
  const { client, terminatedIds } = fakeTemporal(workflows);
  await terminateStaleWorkflowsWithClient(client, WORKSPACES);
  return terminatedIds;
}

const QUEUE_CASES: Array<{
  name: string;
  workflows: Workflow[];
  terminated: string[];
  because: string;
}> = [
  {
    name: 'never terminates a generation-scoped production queue',
    workflows: [
      { workflowId: 'prod-generation', taskQueue: 'navi-agent-tasks@ebdc7ba275e9' },
      { workflowId: 'prod-current', taskQueue: 'navi-agent-tasks@0b52639dcf8b' },
      { workflowId: 'prod-plain', taskQueue: 'navi-agent-tasks' },
    ],
    terminated: [],
    because: 'production workflows must never be terminated by cleanup',
  },
  {
    name: 'never terminates queues it cannot attribute to a workspace',
    workflows: [
      { workflowId: 'unknown-queue', taskQueue: 'some-other-service-queue' },
      { workflowId: 'deployment-markers', taskQueue: 'navi-worker-deployment-markers' },
      { workflowId: 'empty-queue', taskQueue: '' },
      { workflowId: 'fleet-bench', taskQueue: 'navi-agent-tasks-flt-abc' },
      { workflowId: 'isolated-bench', taskQueue: 'navi-agent-tasks-pattaya-bench-1-2-3' },
      // The shared e2e queue is not a Conductor workspace at all (326 running
      // workflows at the time of the incident).
      { workflowId: 'shared-test', taskQueue: 'navi-agent-tasks-test' },
    ],
    terminated: [],
    because: 'unattributable queues must be kept, not terminated',
  },
  {
    name: 'never terminates an ACTIVE workspace decorated queue',
    // `abu-dhabi` is active, so neither its in-flight deploy lane
    // (scripts/lib/deploy-local-env.sh) nor a generation-suffixed worker queue
    // may be read as an archived workspace named "abu-dhabi-deploy-...".
    workflows: [
      { workflowId: 'active-plain', taskQueue: 'navi-agent-tasks-abu-dhabi' },
      {
        workflowId: 'active-deploy-lane',
        taskQueue: 'navi-agent-tasks-abu-dhabi-deploy-20260804022751-60927',
      },
      { workflowId: 'active-generation', taskQueue: 'navi-agent-tasks-abu-dhabi@somehash' },
    ],
    terminated: [],
    because: 'active workspace queues must never be terminated',
  },
  {
    name: 'still terminates archived workspace queues, including decorated ones',
    workflows: [
      { workflowId: 'archived', taskQueue: 'navi-agent-tasks-deleted-workspace' },
      {
        workflowId: 'archived-deploy-lane',
        taskQueue: 'navi-agent-tasks-old-town-deploy-20260804022751-60927',
      },
      { workflowId: 'archived-generation', taskQueue: 'navi-agent-tasks-old-town@somehash' },
      { workflowId: 'active', taskQueue: 'navi-agent-tasks-pattaya' },
      { workflowId: 'prod-generation', taskQueue: 'navi-agent-tasks@ebdc7ba275e9' },
    ],
    terminated: ['archived', 'archived-deploy-lane', 'archived-generation'],
    because: 'archived workspace queues are still cleaned up',
  },
];

async function main(): Promise<void> {
  for (const { name, run } of [...IDENTITY_CASES, ...FAILURE_CASES]) {
    await test(name, run);
  }

  for (const testCase of QUEUE_CASES) {
    await test(testCase.name, async () =>
      assert.deepEqual(
        await terminatedFor(testCase.workflows),
        testCase.terminated,
        testCase.because
      )
    );
  }

  await test('dry run reports targets without terminating anything', async () => {
    const { client, terminatedIds } = fakeTemporal([
      { workflowId: 'archived', taskQueue: 'navi-agent-tasks-deleted-workspace' },
    ]);
    const result = await terminateStaleWorkflowsWithClient(client, WORKSPACES, { dryRun: true });
    assert.equal(result.terminated, 1);
    assert.deepEqual(terminatedIds, [], 'dry run must not terminate');
  });

  console.log('cleanup stale workspace identity tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
