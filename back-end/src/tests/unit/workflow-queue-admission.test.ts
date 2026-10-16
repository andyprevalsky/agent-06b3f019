/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import {
  workflowStartMembership,
  hasUnacknowledgedWorkflowStart,
} from '../../providers/workflowStartPending';
import { setCurrentAgentQueue } from '../../providers/agentQueuePointer';
import { startAgentWorkflowExecutionWithClient } from '../../providers/temporal';
import {
  beginQueueRetirement,
  requireQueueRetirementReady,
  queueAdmissionKey,
  claimWorkflowStart,
  acknowledgeWorkflowStart,
  isWorkflowStartAdmissionPending,
  START_ADMISSION_OPERATION,
  nativeWorkflowTerminal,
} from '../../providers/workflowQueueAdmission';
import { createTestHarness } from './trace-archive-test-utils';
const { test, finish } = createTestHarness('durable workflow queue admission');
const oldQueue = 'admission-test-old';
const targetQueue = 'admission-test-current';
type Row = {
  operationKey: string;
  operationType: string;
  status: string;
  externalId?: string;
  request: unknown;
};
function storage() {
  const rows = new Map<string, Row>();
  const gate = (queue: string, phase: string) => ({
    version: 1,
    queue,
    phase,
    incarnation: 'epoch-1',
    owner: 'deploy-1',
    surfaceHash: 'target-hash',
    legacyCoverage: 'QUALIFIED',
    legacyCertificate: {
      producerTransition: 'external-complete-producer-proof',
      cohortManifest: 'external-complete-cohort-proof',
      unresolved: 0,
    },
  });
  rows.set(queueAdmissionKey(oldQueue), {
    operationKey: queueAdmissionKey(oldQueue),
    operationType: 'AGENT_QUEUE_ADMISSION',
    status: 'OPEN',
    request: gate(oldQueue, 'OPEN'),
  });
  rows.set(queueAdmissionKey(targetQueue), {
    operationKey: queueAdmissionKey(targetQueue),
    operationType: 'AGENT_QUEUE_ADMISSION',
    status: 'OPEN',
    request: gate(targetQueue, 'OPEN'),
  });
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (_sql: unknown, _key: string) => [],
    agentQueuePointer: {
      findUnique: async () => ({ taskQueue: targetQueue, surfaceHash: 'target-hash' }),
      upsert: async (args: unknown) => args,
    },
    toolSideEffect: {
      findUnique: async ({ where }: { where: { operationKey: string } }) =>
        structuredClone(rows.get(where.operationKey) ?? null),
      create: async ({ data }: { data: Row }) => {
        assert(!rows.has(data.operationKey));
        rows.set(data.operationKey, structuredClone(data));
        return data;
      },
      update: async ({ where, data }: { where: { operationKey: string }; data: Partial<Row> }) => {
        const next = { ...rows.get(where.operationKey)!, ...structuredClone(data) };
        rows.set(where.operationKey, next);
        return next;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { operationKey: string };
        create: Row;
        update: Partial<Row>;
      }) => {
        const next = rows.has(where.operationKey)
          ? { ...rows.get(where.operationKey)!, ...structuredClone(update) }
          : structuredClone(create);
        rows.set(where.operationKey, next);
        return next;
      },
      findMany: async ({
        where,
      }: {
        where: { operationType: string; request: { path: string[]; equals: string } };
      }) =>
        structuredClone(
          [...rows.values()].filter(
            (row) =>
              row.operationType === where.operationType &&
              (row.request as Record<string, unknown>)[where.request.path[0]] ===
                where.request.equals
          )
        ),
    },
  };
  return { tx, rows, gate };
}
const params = {
  agentId: 'offline-admission-agent',
  userId: 'offline-user',
  goal: 'actual local queue ownership assertion',
  model: 'test-model',
  reasoningMaxTokens: 2048,
  verifier: { type: 'FLOAT_LLM_JUDGE' },
  taskQueue: oldQueue,
};
async function main() {
  const original = prisma.$transaction;
  try {
    await test('retired explicit destination is routed only to fresh verified OPEN target', async () => {
      const { tx, rows, gate } = storage();
      rows.get(queueAdmissionKey(oldQueue))!.request = gate(oldQueue, 'RETIRED');
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      const calls: { taskQueue: string; workflowId: string; args: unknown[] }[] = [];
      const client = {
        withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
        workflow: {
          start: async (
            _type: string,
            options: { taskQueue: string; workflowId: string; args: unknown[] }
          ) => {
            calls.push(options);
            return { workflowId: params.agentId, firstExecutionRunId: 'first-run' };
          },
        },
      };
      await startAgentWorkflowExecutionWithClient(client as never, params);
      assert.deepEqual(
        calls.map((call) => call.taskQueue),
        [targetQueue],
        'actual helper admitted retired old destination'
      );
      assert.equal(calls[0].workflowId, params.agentId, 'legacy reusable root identity changed');
      assert.equal(calls[0].args[2], params.goal, 'authored goal changed');
    });
    await test('actual closed membership prevents retirement while native acknowledgement is held', async () => {
      const { tx } = storage();
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      let entered!: () => void;
      const atRpc = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let oldPollers = 8;
      const accepted: number[] = [];
      const client = {
        withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
        workflow: {
          start: async () => {
            entered();
            await held;
            accepted.push(oldPollers);
            return { workflowId: params.agentId, firstExecutionRunId: 'held-first-run' };
          },
        },
      };
      const pending = startAgentWorkflowExecutionWithClient(client as never, params);
      await atRpc;
      await beginQueueRetirement(oldQueue, 'deploy-1');
      // Native visibility is still zero. Only the real readiness owner may
      // authorize worker retirement; it must account for this held RPC.
      try {
        await requireQueueRetirementReady(oldQueue, 'deploy-1', async (execution) => ({
          firstExecutionRunId: execution.firstExecutionRunId,
          queue: targetQueue,
          terminal: true,
        }));
        oldPollers = 0;
      } catch {
        /* pending membership keeps existing workers served */
      }
      release();
      await pending;
      assert.deepEqual(
        accepted,
        [8],
        'old native RPC accepted after actual retirement owner permitted zero-poller closure'
      );
    });

    await test('ACK plus terminal ALLOW_DUP chain never discharges ambiguous native retries', async () => {
      const { tx, rows } = storage();
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      const intent = await claimWorkflowStart(
        params.agentId,
        params.agentId,
        oldQueue,
        false,
        Date.now() + 5000
      );
      await acknowledgeWorkflowStart(
        intent,
        { workflowId: params.agentId, firstExecutionRunId: 'closed-reusable-run' },
        Date.now() + 5000
      );
      await beginQueueRetirement(oldQueue, 'deploy-1');
      let reads = 0;
      await assert.rejects(
        requireQueueRetirementReady(oldQueue, 'deploy-1', async () => {
          reads++;
          return { firstExecutionRunId: 'closed-reusable-run', queue: oldQueue, terminal: true };
        }),
        /wire outcome remains unresolved/
      );
      assert.equal(reads, 0);
      assert.equal(
        (rows.get(queueAdmissionKey(oldQueue))!.request as { phase: string }).phase,
        'RETIRING'
      );
    });
    await test('immutable native chain must be positively away or terminal, including unknown negatives', async () => {
      for (const observation of [
        { firstExecutionRunId: 'immutable-first', queue: oldQueue, terminal: false },
        { firstExecutionRunId: 'immutable-first', queue: '', terminal: false },
        { firstExecutionRunId: 'wrong-first', queue: targetQueue, terminal: true },
        { firstExecutionRunId: 'immutable-first', queue: targetQueue, terminal: false },
        { firstExecutionRunId: 'immutable-first', queue: oldQueue, terminal: true },
      ]) {
        const { tx, rows } = storage();
        prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
        const intent = await claimWorkflowStart(
          params.agentId,
          'immutable-physical-child',
          oldQueue,
          true,
          Date.now() + 5000
        );
        await acknowledgeWorkflowStart(
          intent,
          { workflowId: 'immutable-physical-child', firstExecutionRunId: 'immutable-first' },
          Date.now() + 5000
        );
        await beginQueueRetirement(oldQueue, 'deploy-1');
        const valid =
          observation.firstExecutionRunId === 'immutable-first' &&
          !!observation.queue &&
          (observation.terminal || observation.queue === targetQueue);
        if (valid) {
          await requireQueueRetirementReady(oldQueue, 'deploy-1', async () => observation);
          assert.equal(
            (rows.get(queueAdmissionKey(oldQueue))!.request as { phase: string }).phase,
            'RETIRED'
          );
        } else
          await assert.rejects(
            requireQueueRetirementReady(oldQueue, 'deploy-1', async () => observation)
          );
      }
    });
    await test('legacy coverage unknown blocks retirement independently of zero members', async () => {
      const { tx, rows, gate } = storage();
      rows.get(queueAdmissionKey(oldQueue))!.request = {
        ...gate(oldQueue, 'OPEN'),
        legacyCoverage: 'UNKNOWN',
      };
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      await beginQueueRetirement(oldQueue, 'deploy-1');
      await assert.rejects(
        requireQueueRetirementReady(oldQueue, 'deploy-1', async () => {
          throw new Error('must not query native');
        }),
        /Legacy producer/
      );
    });
    await test('missing or mismatched current OPEN target denies before native start', async () => {
      for (const variant of ['missing', 'closed', 'hash']) {
        const { tx, rows, gate } = storage();
        rows.get(queueAdmissionKey(oldQueue))!.request = gate(oldQueue, 'RETIRED');
        if (variant === 'missing') rows.delete(queueAdmissionKey(targetQueue));
        else
          rows.get(queueAdmissionKey(targetQueue))!.request = {
            ...gate(targetQueue, variant === 'closed' ? 'RETIRING' : 'OPEN'),
            ...(variant === 'hash' ? { surfaceHash: 'foreign-hash' } : {}),
          };
        prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
        let calls = 0;
        await assert.rejects(
          startAgentWorkflowExecutionWithClient(
            {
              withDeadline: async (_: number, run: () => Promise<unknown>) => run(),
              workflow: {
                start: async () => {
                  calls++;
                  return { workflowId: params.agentId, firstExecutionRunId: 'known-first' };
                },
              },
            } as never,
            params
          ),
          isWorkflowStartAdmissionPending
        );
        assert.equal(calls, 0);
      }
    });
    await test('native or ACK-write failure preserves same pending error and durable membership', async () => {
      for (const site of ['native', 'ack']) {
        const { tx, rows } = storage();
        const error = new Error('actual external ' + site + ' failure');
        if (site === 'ack')
          tx.toolSideEffect.update = async () => {
            throw error;
          };
        prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
        await assert.rejects(
          startAgentWorkflowExecutionWithClient(
            {
              withDeadline: async (_: number, run: () => Promise<unknown>) => run(),
              workflow: {
                start: async () => {
                  if (site === 'native') throw error;
                  return { workflowId: params.agentId, firstExecutionRunId: 'accepted-run' };
                },
              },
            } as never,
            params
          ),
          (actual: unknown) => actual === error && isWorkflowStartAdmissionPending(actual)
        );
        const starts = [...rows.values()].filter(
          (row) => row.operationType === START_ADMISSION_OPERATION
        );
        assert.equal(starts.length, 1);
        assert.equal(starts[0].status, 'STARTED');
      }
    });
    await test('membership mutation during exact native reconciliation blocks final retirement CAS', async () => {
      const { tx, rows } = storage();
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      const intent = await claimWorkflowStart(
        params.agentId,
        'immutable-child',
        oldQueue,
        true,
        Date.now() + 5000
      );
      await acknowledgeWorkflowStart(
        intent,
        { workflowId: 'immutable-child', firstExecutionRunId: 'first' },
        Date.now() + 5000
      );
      await beginQueueRetirement(oldQueue, 'deploy-1');
      await assert.rejects(
        requireQueueRetirementReady(oldQueue, 'deploy-1', async () => {
          [...rows.values()].find(
            (row) => row.operationType === START_ADMISSION_OPERATION
          )!.status = 'STARTED';
          return { firstExecutionRunId: 'first', queue: targetQueue, terminal: true };
        }),
        /membership changed/
      );
    });
    await test('pointer publication atomically establishes OPEN and cannot reopen retired queues', async () => {
      const { tx, rows, gate } = storage();
      rows.delete(queueAdmissionKey(targetQueue));
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      await setCurrentAgentQueue(targetQueue, 'target-hash', 'deploy-1');
      assert.equal(
        (rows.get(queueAdmissionKey(targetQueue))!.request as { phase: string }).phase,
        'OPEN'
      );
      assert.equal(
        (rows.get(queueAdmissionKey(targetQueue))!.request as { legacyCoverage: string })
          .legacyCoverage,
        'UNKNOWN'
      );
      rows.get(queueAdmissionKey(oldQueue))!.request = gate(oldQueue, 'RETIRED');
      await assert.rejects(
        setCurrentAgentQueue(oldQueue, 'target-hash', 'deploy-2'),
        /qualified reactivation/
      );
    });

    await test('10k distinct admission intents preserve independent keyed ownership and closed membership', async () => {
      const { tx, rows } = storage();
      const keys = new Set<string>();
      tx.$queryRaw = async (_sql: unknown, key: string) => {
        keys.add(key);
        return [];
      };
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      await Promise.all(
        Array.from({ length: 10_000 }, (_, index) =>
          claimWorkflowStart(
            'agent-' + index,
            'child-' + index,
            oldQueue,
            true,
            Date.now() + 30_000
          )
        )
      );
      assert.equal(keys.size, 10_000);
      assert.equal(
        [...rows.values()].filter((row) => row.operationType === START_ADMISSION_OPERATION).length,
        10_000
      );
      await beginQueueRetirement(oldQueue, 'deploy-1');
      await assert.rejects(
        requireQueueRetirementReady(oldQueue, 'deploy-1', async () => {
          throw new Error('pending members must not query native');
        }),
        /outcome remains unresolved/
      );
    });

    await test('native unknown and unspecified statuses cannot masquerade as terminal', () => {
      for (const status of ['UNKNOWN', 'UNSPECIFIED', '', 'FUTURE_STATUS'])
        assert.throws(() => nativeWorkflowTerminal(status));
      for (const status of ['COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT'])
        assert.equal(nativeWorkflowTerminal(status), true);
      assert.equal(nativeWorkflowTerminal('RUNNING'), false);
    });

    await test('ACK persistence waits for the terminal owner generation lock before mutating membership', async () => {
      const { tx, rows } = storage();
      prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn(tx)) as never;
      const intent = await claimWorkflowStart(
        'ack-lock-agent',
        'immutable-lock-child',
        oldQueue,
        true,
        Date.now() + 5000
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      tx.$queryRaw = async (_sql: unknown, key: string) => {
        assert.equal(key, 'ack-lock-agent:workflow-generation');
        entered = true;
        await held;
        return [];
      };
      const ack = acknowledgeWorkflowStart(
        intent,
        { workflowId: 'immutable-lock-child', firstExecutionRunId: 'lock-first-run' },
        Date.now() + 5000
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          entered,
          true,
          'ACK bypassed the same keyed generation lock used by final terminal comparison'
        );
        const member = [...rows.values()].find(
          (row) => row.operationType === START_ADMISSION_OPERATION
        )!;
        assert.equal(
          member.status,
          'STARTED',
          'ACK changed membership while terminal owner still holds its lock'
        );
      } finally {
        release();
        await ack;
      }
      assert.equal(
        [...rows.values()].find((row) => row.operationType === START_ADMISSION_OPERATION)!.status,
        'COMPLETED'
      );
    });

    await test('per-agent membership and pending reads constrain the existing externalId index', async () => {
      const first = prisma.toolSideEffect.findFirst,
        many = prisma.toolSideEffect.findMany;
      const reads: Record<string, unknown>[] = [];
      try {
        prisma.toolSideEffect.findFirst = (async ({
          where,
        }: {
          where: Record<string, unknown>;
        }) => {
          reads.push(where);
          return null;
        }) as never;
        prisma.toolSideEffect.findMany = (async ({ where }: { where: Record<string, unknown> }) => {
          reads.push(where);
          return [];
        }) as never;
        await hasUnacknowledgedWorkflowStart('indexed-agent', 'indexed-workflow');
        await workflowStartMembership('indexed-agent', 'indexed-workflow');
        assert.equal(reads.length, 2);
        for (const where of reads)
          assert.equal(
            where.externalId,
            'indexed-agent',
            'per-agent read omitted existing indexed Agent identity'
          );
      } finally {
        prisma.toolSideEffect.findFirst = first;
        prisma.toolSideEffect.findMany = many;
      }
    });
  } finally {
    prisma.$transaction = original;
    await prisma.$disconnect();
  }
  finish();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
