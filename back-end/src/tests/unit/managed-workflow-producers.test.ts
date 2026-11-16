import { runAbsenceCases } from './managed-workflow-absence.cases';
/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { WorkflowNotFoundError } from '@temporalio/client';
import { createHash } from 'node:crypto';
import { initializeManagedQueue } from '../../providers/workflowManagedQueue';
import { prisma } from '../../providers/database';
import { getAgentQueuePointerPayload } from '../../domains/agent-queue-pointer/service';
import { startAgentWorkflowExecutionWithClient } from '../../providers/temporal';
import { admitQueueContinuation } from '../../providers/workflowQueueContinuation';
import {
  claimWorkflowStart,
  beginQueueRetirement,
  requireQueueRetirementReady,
} from '../../providers/workflowQueueAdmission';
import { createTestHarness } from './trace-archive-test-utils';
const { test, finish } = createTestHarness('managed workflow producers');
const queue = `navi-agent-tasks-pool-0123456789ab@${'a'.repeat(12)}`;
async function main() {
  const originalTransaction = prisma.$transaction;
  const originalPointer = prisma.agentQueuePointer.findUnique;
  const rows = new Map<string, Record<string, unknown>>();
  rows.set(`agent-queue-admission:${queue}`, {
    operationKey: `agent-queue-admission:${queue}`,
    operationType: 'AGENT_QUEUE_ADMISSION',
    request: {
      version: 1,
      queue,
      incarnation: 'fresh-1',
      owner: 'deployment',
      phase: 'OPEN',
      surfaceHash: 'a'.repeat(12),
      legacyCoverage: 'QUALIFIED',
    },
  });
  rows.set('deployment:temporal-workflow-cutover', {
    operationType: 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE',
    status: 'STARTED',
    externalId: 'deploy-owner',
    request: { leaseMs: 120000 },
    updatedAt: new Date(),
  });
  const agent = {
    id: 'logical-agent',
    temporalWorkflowId: null as string | null,
    temporalFirstExecutionRunId: null as string | null,
    deletedAt: null,
    status: 'ACTIVE',
  };
  let pointer = { taskQueue: queue, surfaceHash: 'a'.repeat(12) };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ now: new Date() }],
    agentQueuePointer: { findUnique: async () => pointer },
    agent: {
      findUnique: async () => ({ ...agent }),
      update: async ({ data }: { data: object }) => Object.assign(agent, data),
    },
    toolSideEffect: {
      findFirst: async () => null,
      findMany: async ({
        where,
      }: {
        where: { operationType: string; request?: { equals: string }; externalId?: string };
      }) =>
        structuredClone(
          [...rows.values()].filter(
            (r) =>
              r.operationType === where.operationType &&
              (where.request === undefined ||
                (r.request as { queue: string }).queue === where.request.equals) &&
              ((where as { externalId?: string }).externalId === undefined ||
                r.externalId === (where as { externalId?: string }).externalId)
          )
        ),
      findUnique: async ({ where }: { where: { operationKey: string } }) =>
        rows.get(where.operationKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.set(String(data.operationKey), structuredClone(data));
        return data;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { operationKey: string };
        create: Record<string, unknown>;
        update: object;
      }) => {
        const value = rows.has(where.operationKey)
          ? Object.assign(rows.get(where.operationKey)!, update)
          : create;
        rows.set(where.operationKey, value);
        return value;
      },
      update: async ({ where, data }: { where: { operationKey: string }; data: object }) => {
        const row = Object.assign(rows.get(where.operationKey)!, data);
        return row;
      },
    },
  };
  try {
    let tail = Promise.resolve();
    prisma.$transaction = (async (fn: (tx: unknown) => unknown) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(tx);
      } finally {
        release();
      }
    }) as never;
    prisma.agentQueuePointer.findUnique = (async () => ({
      taskQueue: queue,
      surfaceHash: 'a'.repeat(12),
    })) as never;
    await runAbsenceCases(
      test,
      rows,
      agent,
      queue,
      () => pointer,
      (value) => {
        pointer = value;
      }
    );
    await test('managed pointer never exposes a continuation destination without native source identity', async () => {
      await assert.rejects(getAgentQueuePointerPayload(), /identity/i);
    });
    await test('transaction retry cannot retain an uncommitted physical identity', async () => {
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      const savedRows = structuredClone(rows);
      const savedAgent = { ...agent };
      const transaction = async (fn: (value: typeof tx) => Promise<unknown>) => {
        await fn(tx);
        rows.clear();
        for (const [key, row] of savedRows) rows.set(key, row);
        Object.assign(agent, savedAgent);
        return fn(tx);
      };
      const intent = await claimWorkflowStart(
        agent.id,
        agent.id,
        queue,
        false,
        Date.now() + 15000,
        transaction as never,
        'same-args',
        new Map([[`logical:${agent.id}`, { workflowId: agent.id, status: 'ABSENT' as const }]])
      );
      assert.equal(intent.workflowId, agent.temporalWorkflowId);
      assert(rows.has(`agent-physical-start:${agent.id}:${intent.workflowId}`));
      // This direct provider regression deliberately has no native wire/ACK.
      rows.delete(`agent-queue-start:${intent.id}`);
      agent.temporalWorkflowId = null;
    });
    await test('ordinary root physical start is immutable while logical agent and SDK args stay unchanged', async () => {
      const calls: Array<{ workflowId: string; workflowIdReusePolicy?: string; args: unknown[] }> =
        [];
      const client = {
        withDeadline: async (_d: number, fn: () => Promise<unknown>) => fn(),
        workflow: {
          getHandle: () => ({
            describe: async () => {
              throw new WorkflowNotFoundError('offline absent', agent.id, undefined);
            },
          }),
          start: async (
            _type: string,
            options: { workflowId: string; workflowIdReusePolicy?: string; args: unknown[] }
          ) => {
            calls.push(options);
            return { workflowId: options.workflowId, firstExecutionRunId: 'native-first' };
          },
        },
      };
      const params = {
        agentId: agent.id,
        userId: 'user',
        goal: 'same logical goal',
        model: 'test-model',
        reasoningMaxTokens: 2048,
        verifier: { type: 'FLOAT_LLM_JUDGE' },
        taskQueue: queue,
      };
      const first = await startAgentWorkflowExecutionWithClient(client as never, params);
      const second = await startAgentWorkflowExecutionWithClient(client as never, params);
      assert.notEqual(first.workflowId, agent.id);
      assert.equal(
        first.workflowId,
        second.workflowId,
        'retry allocated a second physical execution'
      );
      assert.equal(calls[0].workflowIdReusePolicy, 'REJECT_DUPLICATE');
      assert.equal(calls[0].args[0], agent.id, 'logical agent argument changed');
      assert.deepEqual(calls[0].args, calls[1].args);
    });
    await test('legacy no-ref roots require native terminal or canonical not-found; transport uncertainty blocks', async () => {
      const savedRows = structuredClone(rows),
        savedAgent = { ...agent };
      let calls = 0,
        mode = 'RUNNING';
      const client = {
        withDeadline: async (_d: number, fn: () => Promise<unknown>) => fn(),
        workflow: {
          getHandle: (workflowId: string) => ({
            describe: async () => {
              assert.equal(workflowId, agent.id);
              if (mode === 'NOT_FOUND')
                throw new WorkflowNotFoundError('absent', workflowId, undefined);
              if (mode === 'TRANSPORT') throw new Error('transport unavailable');
              return {
                raw: { workflowExecutionInfo: { firstRunId: 'legacy-first' } },
                status: { name: mode },
              };
            },
          }),
          start: async (_t: string, options: { workflowId: string }) => {
            calls++;
            return { workflowId: options.workflowId, firstExecutionRunId: 'native-first' };
          },
        },
      };
      const params = {
        agentId: agent.id,
        userId: 'user',
        goal: 'legacy followup',
        model: 'test',
        reasoningMaxTokens: 2048,
        verifier: { type: 'test' },
        taskQueue: queue,
      };
      try {
        for (const status of ['RUNNING', 'TRANSPORT', 'COMPLETED', 'NOT_FOUND']) {
          for (const [key, row] of rows)
            if (
              row.operationType === 'AGENT_QUEUE_START' ||
              row.operationType === 'AGENT_PHYSICAL_START'
            )
              rows.delete(key);
          agent.temporalWorkflowId = null;
          agent.temporalFirstExecutionRunId = null;
          mode = status;
          if (status === 'RUNNING' || status === 'TRANSPORT')
            await assert.rejects(
              startAgentWorkflowExecutionWithClient(client as never, params),
              /reconciliation is pending/
            );
          else await startAgentWorkflowExecutionWithClient(client as never, params);
        }
        assert.equal(calls, 2);
      } finally {
        rows.clear();
        for (const [key, row] of savedRows) rows.set(key, row);
        Object.assign(agent, savedAgent);
      }
    });
    await test('held concurrent root RPC retries preserve one physical ID and later logical turn gets a new ID', async () => {
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      let entered!: () => void;
      const atWire = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ids: string[] = [];
      let terminal = true;
      const client = {
        withDeadline: async (_d: number, fn: () => Promise<unknown>) => fn(),
        workflow: {
          getHandle: () => ({
            describe: async () => ({
              raw: { workflowExecutionInfo: { firstRunId: 'native-first' } },
              status: { name: terminal ? 'COMPLETED' : 'RUNNING' },
            }),
          }),
          start: async (_type: string, options: { workflowId: string }) => {
            ids.push(options.workflowId);
            if (ids.length === 1) {
              terminal = false;
              entered();
              await held;
            }
            return { workflowId: options.workflowId, firstExecutionRunId: 'native-first' };
          },
        },
      };
      const params = {
        agentId: agent.id,
        userId: 'user',
        goal: 'concurrent',
        model: 'test',
        reasoningMaxTokens: 2048,
        verifier: { type: 'test' },
        taskQueue: queue,
      };
      const first = startAgentWorkflowExecutionWithClient(client as never, params);
      await atWire;
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      try {
        const second = await startAgentWorkflowExecutionWithClient(client as never, params);
        assert.equal(ids[0], second.workflowId);
        await assert.rejects(
          startAgentWorkflowExecutionWithClient(client as never, {
            ...params,
            goal: 'different pending start',
          }),
          /retained generation/
        );
      } finally {
        release();
        await first;
      }
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      await assert.rejects(
        startAgentWorkflowExecutionWithClient(client as never, params),
        /natively terminal/
      );
      terminal = true;
      const next = await startAgentWorkflowExecutionWithClient(client as never, params);
      assert.notEqual(next.workflowId, ids[0], 'later logical turn reused physical ID');
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      const getHandle = client.workflow.getHandle;
      client.workflow.getHandle = ((workflowId: string) => {
        assert.equal(
          workflowId,
          next.workflowId,
          'expired already-proven history was re-described'
        );
        return getHandle();
      }) as typeof getHandle;
      await startAgentWorkflowExecutionWithClient(client as never, params);
    });
    await test('existing replacement and descendant immutable IDs preserve their exact SDK start identity', async () => {
      const ids: string[] = [];
      const client = {
        withDeadline: async (_d: number, fn: () => Promise<unknown>) => fn(),
        workflow: {
          getHandle: () => ({
            describe: async () => {
              throw new WorkflowNotFoundError('offline absent', agent.id, undefined);
            },
          }),
          start: async (
            _t: string,
            options: { workflowId: string; workflowIdReusePolicy: string }
          ) => {
            assert.equal(options.workflowIdReusePolicy, 'REJECT_DUPLICATE');
            ids.push(options.workflowId);
            return { workflowId: options.workflowId, firstExecutionRunId: 'native-first' };
          },
        },
      };
      for (const workflowId of ['existing-replacement-planned-id', 'existing-child-id']) {
        const result = await startAgentWorkflowExecutionWithClient(client as never, {
          agentId: agent.id,
          workflowId,
          rejectDuplicateWorkflowId: true,
          userId: 'user',
          goal: 'existing immutable start',
          model: 'test',
          reasoningMaxTokens: 2048,
          verifier: { type: 'test' },
          taskQueue: queue,
        });
        assert.equal(result.workflowId, workflowId);
      }
      assert.deepEqual(ids, ['existing-replacement-planned-id', 'existing-child-id']);
    });
    await test('prepared managed target rejects direct root and child starts before pointer publication', async () => {
      pointer = { taskQueue: 'legacy-current', surfaceHash: 'legacy' };
      let starts = 0;
      const client = {
        withDeadline: async (_d: number, fn: () => Promise<unknown>) => fn(),
        workflow: {
          getHandle: () => ({
            describe: async () => {
              throw new WorkflowNotFoundError('offline absent', agent.id, undefined);
            },
          }),
          start: async () => {
            starts++;
            throw Error('unexpected wire');
          },
        },
      };
      for (const rejectDuplicateWorkflowId of [false, true])
        await assert.rejects(
          startAgentWorkflowExecutionWithClient(client as never, {
            agentId: agent.id,
            userId: 'user',
            goal: 'staged',
            model: 'test',
            reasoningMaxTokens: 2048,
            verifier: { type: 'test' },
            taskQueue: queue,
            rejectDuplicateWorkflowId,
          }),
          /published/
        );
      assert.equal(starts, 0);
      pointer = { taskQueue: queue, surfaceHash: 'a'.repeat(12) };
    });
    await test('fresh initializer binds job and source and never upgrades an existing UNKNOWN gate', async () => {
      const jobId = 'owned-job';
      const surfaceHash = 'b'.repeat(12);
      const fresh = `navi-agent-tasks-pool-${createHash('sha256').update(jobId).digest('hex').slice(0, 12)}@${surfaceHash}`;
      const input = { queue: fresh, surfaceHash, jobId, sourceCommit: 'c'.repeat(40) };
      await assert.rejects(
        initializeManagedQueue(input, 'deploy-owner'),
        /matching owned deployment job/
      );
      rows.set(`deployment:worker-job:${jobId}`, {
        operationType: 'WORKER_DEPLOYMENT_JOB',
        request: {
          version: 1,
          jobId,
          stage: 'PREPARING',
          ownerId: 'deploy-owner',
          identity: { sourceCommit: input.sourceCommit, surfaceHash },
        },
      });
      await initializeManagedQueue(input, 'deploy-owner');
      const gate = rows.get(`agent-queue-admission:${fresh}`)!.request as {
        legacyCoverage: string;
      };
      assert.equal(gate.legacyCoverage, 'QUALIFIED');
      const incarnation = (gate as { incarnation?: string }).incarnation;
      await initializeManagedQueue(input, 'deploy-owner');
      assert.equal(
        (rows.get(`agent-queue-admission:${fresh}`)!.request as { incarnation: string })
          .incarnation,
        incarnation,
        'resume replaced the queue incarnation'
      );
      await assert.rejects(initializeManagedQueue(input, 'stale-owner'), /lease/);
      gate.legacyCoverage = 'UNKNOWN';
      await assert.rejects(initializeManagedQueue(input, 'deploy-owner'), /not fresh/);
      assert.equal(gate.legacyCoverage, 'UNKNOWN');
      await assert.rejects(
        initializeManagedQueue(input, 'deploy-owner', { forRetirement: true }),
        /not fresh/
      );
      assert.equal(gate.legacyCoverage, 'UNKNOWN');
      await assert.rejects(
        initializeManagedQueue({ ...input, queue: queue }, 'deploy-owner'),
        /identity/
      );
    });
    await test('native continuation ticket blocks retirement until source ended and destination no longer needed', async () => {
      const identity = { workflowId: 'legacy-chain', runId: 'old-run' };
      const native = {
        firstExecutionRunId: 'native-first',
        runId: 'old-run',
        queue: 'legacy-source',
        terminal: false,
      };
      assert.equal(await admitQueueContinuation(identity, async () => native), queue);
      const ticket = [...rows.values()].find((r) => r.operationType === 'AGENT_QUEUE_CONTINUATION');
      assert(ticket, 'actual pointer producer omitted durable incoming membership');
      pointer = { taskQueue: 'next-generation', surfaceHash: 'next' };
      const gate = rows.get(`agent-queue-admission:${queue}`)!;
      (gate.request as Record<string, unknown>).legacyCertificate = {
        producerTransition: 'verified-transition',
        cohortManifest: 'fresh-proof',
        unresolved: 0,
      };
      await beginQueueRetirement(queue, 'retirement-owner');
      await assert.rejects(
        requireQueueRetirementReady(queue, 'retirement-owner', async () => native),
        /Continuation/
      );
      await assert.rejects(
        requireQueueRetirementReady(queue, 'retirement-owner', async () => ({
          ...native,
          runId: 'continued-run',
          queue,
        })),
        /chain|Continuation/
      );
      await requireQueueRetirementReady(queue, 'retirement-owner', async () => ({
        ...native,
        runId: 'continued-run',
        queue: 'next-generation',
      }));
      assert.equal(
        (rows.get(`agent-queue-admission:${queue}`)!.request as { phase: string }).phase,
        'RETIRED'
      );
    });
    await test('a failed or retired generation never admits a continuation, so agents stay on their live queue', async () => {
      // RCA 2026-11-15 (agent 08aa04a2): a cooperative handoff must never strand an agent on a
      // generation whose deploy failed or whose bank was retired. The pointer can still name that
      // queue; only a qualified OPEN admission gate may receive a continuation.
      const identity = { workflowId: 'live-agent', runId: 'live-run' };
      const native = {
        firstExecutionRunId: 'live-first',
        runId: 'live-run',
        queue: 'serving-generation',
        terminal: false,
      };
      const gate = rows.get(`agent-queue-admission:${queue}`)!.request as Record<string, unknown>;
      pointer = { taskQueue: queue, surfaceHash: 'a'.repeat(12) };
      assert.equal(gate.phase, 'RETIRED');
      await assert.rejects(admitQueueContinuation(identity, async () => native), /qualified OPEN/);
      gate.phase = 'RETIRING';
      await assert.rejects(admitQueueContinuation(identity, async () => native), /qualified OPEN/);
      gate.phase = 'OPEN';
      gate.legacyCoverage = 'UNKNOWN';
      await assert.rejects(admitQueueContinuation(identity, async () => native), /qualified OPEN/);
      gate.legacyCoverage = 'QUALIFIED';
      pointer = { taskQueue: queue, surfaceHash: 'b'.repeat(12) };
      await assert.rejects(admitQueueContinuation(identity, async () => native), /qualified OPEN/);
      const unpublished = `navi-agent-tasks-pool-0123456789ab@${'c'.repeat(12)}`;
      pointer = { taskQueue: unpublished, surfaceHash: 'c'.repeat(12) };
      await assert.rejects(admitQueueContinuation(identity, async () => native), /qualified OPEN/);
      assert.equal(
        [...rows.values()].filter(
          (r) =>
            r.operationType === 'AGENT_QUEUE_CONTINUATION' &&
            (r.request as { workflowId?: string })?.workflowId === 'live-agent'
        ).length,
        0,
        'a refused continuation records no ticket'
      );
    });
  } finally {
    prisma.$transaction = originalTransaction;
    prisma.agentQueuePointer.findUnique = originalPointer;
    await prisma.$disconnect();
  }
  finish();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
