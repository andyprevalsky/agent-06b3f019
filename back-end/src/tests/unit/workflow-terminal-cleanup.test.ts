#!/usr/bin/env tsx

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  finalizeOwnedSmsCleanup,
  ownedSmsDatabaseTarget,
  SMS_CLEANUP_REPO_ROOT,
  type SmsCleanupDependencies,
} from '../../../scripts/finalize-sms-owned-cleanup';
import { randomUUID } from 'node:crypto';
import { type AgentStatus } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { clearWorkflowForTerminalAgent } from '../../domains/agents/repoMutations';
import { prisma } from '../../providers/database';
import {
  assertNoPendingTerminalAgentWorkflowCleanup,
  cleanupTerminalAgentWorkflowZombies,
  type WorkflowTerminalCleanupDependencies,
} from '../../providers/workflowTerminalCleanup';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow terminal cleanup unit tests');

async function createAgent(runId: string, status: AgentStatus = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: runId,
      goal: `terminal cleanup ${status}`,
      status,
      busId: id,
      temporalWorkflowId: `workflow-${id}`,
      temporalFirstExecutionRunId: `first-${id}`,
      toolsInUse: ['web_search'],
      verifier: { create: {} },
    },
  });
  return id;
}

async function deleteRun(runId: string): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId: runId } });
}

function successfulDependencies(terminations: string[]): WorkflowTerminalCleanupDependencies {
  return {
    resolveExecution: async () => {
      throw new Error('stored first-run identity should avoid describe');
    },
    terminate: async (execution, agentId) => {
      terminations.push(`${agentId}:${execution.workflowId}:${execution.firstExecutionRunId}`);
    },
    captureInProgressTools: async () => [],
    finalizeInterruptedTools: async () => ({ interrupted: 0 }),
  };
}

async function forceCleanup(agentIds: string[], dependencies: WorkflowTerminalCleanupDependencies) {
  return cleanupTerminalAgentWorkflowZombies(dependencies, {
    agentIds,
    ignoreGrace: true,
    batchSize: 20,
    maxConcurrency: 4,
  });
}

async function main(): Promise<void> {
  await test('terminal grace protects normal final-summary tail work', async () => {
    const runId = `workflow-terminal-grace-${randomUUID()}`;
    const agentId = await createAgent(runId);
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    let terminated = false;
    try {
      const result = await cleanupTerminalAgentWorkflowZombies(
        {
          ...successfulDependencies([]),
          terminate: async () => {
            terminated = true;
          },
        },
        { agentIds: [agentId] }
      );
      assert.strictEqual(result.discovered, 0);
      assert.strictEqual(terminated, false);
      assert.strictEqual(await prisma.temporalWorkflowCleanup.count({ where: { agentId } }), 1);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('forced cleanup terminates exact chain and clears stale running UI', async () => {
    const runId = `workflow-terminal-forced-${randomUUID()}`;
    const agentId = await createAgent(runId);
    const workflowId = `workflow-${agentId}`;
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    const events: string[] = [];
    try {
      const result = await forceCleanup([agentId], {
        ...successfulDependencies(events),
        captureInProgressTools: async () => {
          events.push('capture');
          return [];
        },
        finalizeInterruptedTools: async () => {
          events.push('finalize');
          return { interrupted: 0 };
        },
      });
      assert.strictEqual(result.discovered, 1);
      assert.strictEqual(result.terminated, 1);
      assert(events.includes(`${agentId}:${workflowId}:first-${agentId}`));
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.status, 'COMPLETED');
      assert(after.temporalWorkflowId?.includes(':deployment-sealed:'));
      assert.deepStrictEqual(after.toolsInUse, []);
      assert.strictEqual(after.temporalCleanupPending, false);
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('already-closed workflow clears exact obligation without terminate', async () => {
    const runId = `workflow-terminal-closed-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    // Direct starts record only the workflow id, so neither the agent row nor
    // its obligation knows the chain and cleanup must describe it.
    await prisma.agent.update({
      where: { id: agentId },
      data: { temporalFirstExecutionRunId: null },
    });
    await prisma.temporalWorkflowCleanup.update({
      where: {
        agentId_workflowId: { agentId, workflowId: `workflow-${agentId}` },
      },
      data: { firstExecutionRunId: null },
    });
    let terminated = false;
    try {
      await forceCleanup([agentId], {
        ...successfulDependencies([]),
        resolveExecution: async (workflowId) => {
          throw new WorkflowNotFoundError('closed', workflowId, undefined);
        },
        terminate: async () => {
          terminated = true;
        },
      });
      assert.strictEqual(terminated, false);
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('an obligation without a chain adopts the ended row chain exactly', async () => {
    // A descendant can be deleted before its start records the run id, so its
    // obligation is queued without one and the row learns the chain later.
    const runId = `workflow-terminal-rebind-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    await prisma.temporalWorkflowCleanup.update({
      where: {
        agentId_workflowId: { agentId, workflowId: `workflow-${agentId}` },
      },
      data: { firstExecutionRunId: null },
    });
    const terminations: string[] = [];
    try {
      const result = await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(terminations, [`${agentId}:workflow-${agentId}:first-${agentId}`]);
      assert.strictEqual(result.superseded, 1);
      assert.strictEqual(result.sealed, 1);
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('failure retains identity with backoff and later retry is exact', async () => {
    const runId = `workflow-terminal-retry-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    try {
      await assert.rejects(
        forceCleanup([agentId], {
          ...successfulDependencies([]),
          terminate: async () => {
            throw new Error('synthetic termination outage');
          },
        }),
        /cleanup obligation.*failed/i
      );
      const retained = await prisma.temporalWorkflowCleanup.findUniqueOrThrow({
        where: { agentId_workflowId: { agentId, workflowId: `workflow-${agentId}` } },
      });
      assert.strictEqual(retained.firstExecutionRunId, `first-${agentId}`);
      assert.strictEqual(retained.attemptCount, 1);
      assert.strictEqual(retained.leaseToken, null);
      assert.match(retained.lastError ?? '', /synthetic termination outage/);

      const terminations: string[] = [];
      await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(terminations, [`${agentId}:workflow-${agentId}:first-${agentId}`]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('soft-deleted live workflow remains an exact obligation', async () => {
    const runId = `workflow-terminal-deleted-${randomUUID()}`;
    const agentId = await createAgent(runId);
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    const terminations: string[] = [];
    try {
      await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(terminations, [`${agentId}:workflow-${agentId}:first-${agentId}`]);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert(after.deletedAt instanceof Date);
      assert.strictEqual(after.temporalCleanupPending, false);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('two reactivations before sweep preserve both generations', async () => {
    const runId = `workflow-terminal-overlap-${randomUUID()}`;
    const agentId = await createAgent(runId);
    const workflowA = `workflow-${agentId}`;
    const workflowB = `workflow-b-${agentId}`;
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          status: 'COMPLETED',
          progress: 1,
          statusMessage: 'Task completed',
          responseSchema: { fields: [{ name: 'order_confirmation_id', type: 'str' }] },
          structuredResponse: { order_confirmation_id: 'dff187de' },
          toolsInUse: ['spawn_browser_agent'],
        },
      });
      assert.strictEqual(
        (await clearWorkflowForTerminalAgent(agentId, 'COMPLETED', workflowA, `first-${agentId}`))
          .count,
        1
      );
      const cleared = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(cleared.responseSchema, null);
      assert.strictEqual(cleared.structuredResponse, null);
      assert.strictEqual(cleared.progress, 0);
      assert.deepStrictEqual(cleared.toolsInUse, []);
      assert.strictEqual(cleared.statusMessage, null);
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          status: 'ACTIVE',
          temporalWorkflowId: workflowB,
          temporalFirstExecutionRunId: `first-b-${agentId}`,
        },
      });
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'FAILED' } });
      assert.strictEqual(
        (await clearWorkflowForTerminalAgent(agentId, 'FAILED', workflowB, `first-b-${agentId}`))
          .count,
        1
      );
      assert.strictEqual(await prisma.temporalWorkflowCleanup.count({ where: { agentId } }), 2);

      const terminations: string[] = [];
      await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(
        new Set(terminations),
        new Set([
          `${agentId}:${workflowA}:first-${agentId}`,
          `${agentId}:${workflowB}:first-b-${agentId}`,
        ])
      );
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.temporalWorkflowId, null);
      assert.strictEqual(after.status, 'ACTIVE');
      assert.strictEqual(after.temporalCleanupPending, false);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('old backend clear of cost/out cold workflows is captured', async () => {
    const runId = `workflow-terminal-old-backend-${randomUUID()}`;
    const cost = await createAgent(runId, 'COST_LIMIT_REACHED');
    const credits = await createAgent(runId, 'OUT_OF_CREDITS');
    try {
      for (const agentId of [cost, credits]) {
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            status: 'ACTIVE',
            temporalWorkflowId: null,
            temporalFirstExecutionRunId: null,
          },
        });
      }
      assert.strictEqual(
        await prisma.temporalWorkflowCleanup.count({
          where: { agentId: { in: [cost, credits] } },
        }),
        2
      );
      await forceCleanup([cost, credits], successfulDependencies([]));
    } finally {
      await deleteRun(runId);
    }
  });

  await test('cleanup preserves a concurrently installed current workflow', async () => {
    const runId = `workflow-terminal-current-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    const currentWorkflow = `new-current-${agentId}`;
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: 'ACTIVE', temporalWorkflowId: currentWorkflow },
    });
    try {
      await forceCleanup([agentId], successfulDependencies([]));
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.temporalWorkflowId, currentWorkflow);
      assert.strictEqual(after.status, 'ACTIVE');
    } finally {
      await deleteRun(runId);
    }
  });

  await test('two replicas converge on one exact termination', async () => {
    const runId = `workflow-terminal-replicas-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    const terminations: string[] = [];
    try {
      await Promise.all([
        forceCleanup([agentId], successfulDependencies(terminations)),
        forceCleanup([agentId], successfulDependencies(terminations)),
      ]);
      assert.deepStrictEqual(terminations, [`${agentId}:workflow-${agentId}:first-${agentId}`]);
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('poison obligation does not starve another agent in the batch', async () => {
    const runId = `workflow-terminal-poison-${randomUUID()}`;
    const poison = await createAgent(runId, 'FAILED');
    const healthy = await createAgent(runId, 'FAILED');
    const finalized: string[] = [];
    try {
      await assert.rejects(
        forceCleanup([poison, healthy], {
          ...successfulDependencies([]),
          terminate: async (_execution, agentId) => {
            if (agentId === poison) throw new Error('poison');
          },
          finalizeInterruptedTools: async (agentId) => {
            finalized.push(agentId);
          },
        }),
        /cleanup obligation.*failed/i
      );
      assert(finalized.includes(healthy));
      assert(!finalized.includes(poison));
      await assertNoPendingTerminalAgentWorkflowCleanup([healthy]);
      assert.strictEqual(
        await prisma.temporalWorkflowCleanup.count({ where: { agentId: poison } }),
        1
      );
    } finally {
      await deleteRun(runId);
    }
  });

  for (const failure of [
    null,
    'consumer',
    'unknown-obligation',
    'foreign-archive',
    'wrong-first',
    'wrong-queue',
    'running',
    'start-pending',
    'archive',
    'live-lease',
    'foreign-pointer',
    'empty-archive-outbox',
    'force-archive',
    'error-metadata',
  ]) {
    await test(`SMS exact canonical obligation bridge: ${failure ?? 'pending-to-sealed-native-terminal'}`, async () => {
      const context = mkdtempSync(join(tmpdir(), 'sms-exact-obligations-'));
      const root = randomUUID(),
        owner = randomUUID(),
        first = randomUUID();
      const queue = 'sms-owning-queue',
        url = 'postgresql://postgres:postgres@localhost:5432/victoria_sms_adapter_test';
      const oldDatabase = process.env.DATABASE_URL,
        oldDirect = process.env.DIRECT_URL;
      process.env.DATABASE_URL = url;
      process.env.DIRECT_URL = url;
      const receipt = join(context, 'receipt.json');
      const request = {
        context_dir: context,
        receipt_path: receipt,
        base_url: 'http://localhost:39999',
        user_id: owner,
        owned_agent_ids: [root],
        root_agent_ids: [root],
        queue,
        bindings: [{ agent_id: root, workflow_id: root, first_run_id: first }],
        deadline_at_ms: Date.now() + 15000,
        outcome: {
          name: 'fixture',
          passed: failure !== 'error-metadata',
          failure_reason: failure === 'error-metadata' ? 'captured execution error' : null,
          benchmark_status: failure === 'error-metadata' ? 'ERROR' : 'PASSED',
        },
        world_model_mode: failure === 'error-metadata' ? 'shadow' : 'real',
      };
      writeFileSync(
        join(context, 'services.json'),
        JSON.stringify({
          status: 'running',
          benchmark_mode: true,
          worktree: SMS_CLEANUP_REPO_ROOT,
          run_sh_pid: process.pid,
          temporal_task_queue: queue,
          ports: { backend: 39999 },
          database: { name: 'victoria_sms_adapter_test', use_system_postgres: true },
        })
      );
      writeFileSync(
        join(context, 'local-stack-owner.json'),
        JSON.stringify({
          pid: process.pid,
          native_identity: execFileSync(
            'python3',
            [join(SMS_CLEANUP_REPO_ROOT, 'scripts/process-identity.py'), String(process.pid)],
            { encoding: 'utf8' }
          ).trim(),
          token: 'exact-test-token',
        })
      );
      const row = {
        id: root,
        userId: owner,
        parentAgentId: null,
        deletedAt: new Date(),
        temporalWorkflowId: root as string | null,
        temporalFirstExecutionRunId: first as string | null,
        workflowTaskQueue: null,
        temporalWorkflowStartPending: failure === 'start-pending',
        temporalCleanupPending: true,
        staleTemporalWorkflowId: null,
        staleTemporalFirstExecutionRunId: null,
      };
      let obligations = [
        {
          agentId: root,
          workflowId: failure === 'unknown-obligation' ? 'unknown-workflow' : root,
          firstExecutionRunId: first,
        },
      ];
      let archives =
        failure === 'empty-archive-outbox'
          ? []
          : [{ rootAgentId: failure === 'foreign-archive' ? owner : root }];
      const events: string[] = [],
        descriptions: string[] = [];
      const deps = {
        prisma: {
          agent: { findMany: async () => [structuredClone(row)] },
          temporalWorkflowCleanup: { findMany: async () => structuredClone(obligations) },
          traceArchiveFinalization: { findMany: async () => structuredClone(archives) },
        },
        describe: async (binding: { workflow_id: string }) => {
          descriptions.push(binding.workflow_id);
          return {
            taskQueue: failure === 'wrong-queue' ? 'foreign' : queue,
            raw: {
              workflowExecutionInfo: {
                firstRunId: failure === 'wrong-first' ? 'foreign-first' : first,
              },
            },
            status: { name: failure === 'running' ? 'RUNNING' : 'TERMINATED' },
          };
        },
        consume: async (_: unknown, options: { agentIds: string[]; ignoreGrace: boolean }) => {
          events.push('consume');
          assert.deepStrictEqual(options.agentIds, [root]);
          assert.strictEqual(options.ignoreGrace, true);
          if (failure === 'consumer') throw new Error('consumer failed');
          if (failure === 'live-lease') return { discovered: 0, sealed: 0 };
          obligations = [];
          row.temporalCleanupPending = false;
          row.temporalFirstExecutionRunId = null;
          row.temporalWorkflowId =
            failure === 'foreign-pointer'
              ? 'unknown-after-pointer'
              : `${root}:deployment-sealed:${randomUUID()}`;
          return { discovered: 1, sealed: 1 };
        },
        assertNoPending: async (ids: string[]) => {
          assert.deepStrictEqual(ids, [root]);
          if (obligations.length) throw new Error('obligations remain');
        },
        archive: async (options: { rootAgentIds: string[]; ignoreGrace: boolean }) => {
          events.push('archive');
          assert.deepStrictEqual(options.rootAgentIds, [root]);
          assert.strictEqual(options.ignoreGrace, true);
          if (failure === 'archive') throw new Error('archive failed');
          archives = [];
          return { discovered: 1, finalized: 1 };
        },
        finalize: async (options: {
          rootAgentId: string;
          force: boolean;
          benchmarkTaskName: string;
          benchmarkStatus: string;
          failureReason: string | null;
          worldModelMode: string;
        }) => {
          events.push('force-finalize');
          assert.strictEqual(options.rootAgentId, root);
          assert.strictEqual(options.force, true);
          assert.strictEqual(options.benchmarkTaskName, 'fixture');
          assert.strictEqual(options.benchmarkStatus, request.outcome.benchmark_status);
          assert.strictEqual(options.failureReason, request.outcome.failure_reason);
          assert.strictEqual(options.worldModelMode, request.world_model_mode);
          if (failure === 'force-archive') throw new Error('force final archive failed');
          return { manifest: { ref: 'private-fixture-manifest' }, publicManifestRef: null };
        },
      } as unknown as SmsCleanupDependencies;
      try {
        assert.strictEqual(ownedSmsDatabaseTarget(request), url);
        if (failure && !['empty-archive-outbox', 'error-metadata'].includes(failure)) {
          await assert.rejects(() => finalizeOwnedSmsCleanup(request, deps));
          const saved = JSON.parse(readFileSync(receipt, 'utf8'));
          assert.strictEqual(saved.verified, false);
          assert.deepStrictEqual(saved.owned_agent_ids, [root]);
          if (
            [
              'unknown-obligation',
              'foreign-archive',
              'wrong-first',
              'wrong-queue',
              'start-pending',
            ].includes(failure)
          )
            assert.deepStrictEqual(events, []);
        } else {
          const saved = await finalizeOwnedSmsCleanup(request, deps);
          assert.strictEqual(saved.verified, true);
          assert.deepStrictEqual(events, ['consume', 'archive', 'force-finalize']);
          assert.deepStrictEqual(descriptions, [root, root]);
          assert.strictEqual(row.temporalFirstExecutionRunId, null);
          assert.strictEqual(obligations.length, 0);
          assert.strictEqual(archives.length, 0);
          assert.strictEqual(JSON.parse(readFileSync(receipt, 'utf8')).verified, true);
        }
      } finally {
        if (oldDatabase === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = oldDatabase;
        if (oldDirect === undefined) delete process.env.DIRECT_URL;
        else process.env.DIRECT_URL = oldDirect;
        rmSync(context, { recursive: true, force: true });
      }
    });
  }

  await finish();
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
