import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  let row = {
    id: 'agent',
    status: 'ACTIVE',
    userControlRevision: 0,
    temporalWorkflowId: 'workflow',
    userId: 'user',
    parentAgentId: null,
    updatedAt: new Date(),
    workflowIterationOffset: 9,
  };
  let held = false,
    pauseAfterCommit = false,
    accepted = true,
    readThrows = false;
  const events: Array<Record<string, unknown>> = [];
  const clone = () => ({ ...row });
  const tx = {
    agent: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        assert(held);
        if (accepted) row = { ...row, ...data };
        return { count: accepted ? 1 : 0 };
      },
      findUnique: async () => {
        assert(held, 'read snapshot under lock');
        return clone();
      },
    },
    $executeRaw: async (_parts: TemplateStringsArray, offset: number) => {
      assert(held);
      row.workflowIterationOffset = Math.max(row.workflowIterationOffset, offset);
    },
  };
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: {},
      runTransactionWithRetry: async (fn: (value: typeof tx) => Promise<unknown>) => {
        assert(!held);
        held = true;
        try {
          return await fn(tx);
        } finally {
          held = false;
          if (pauseAfterCommit) row = { ...row, status: 'PAUSED', userControlRevision: 1 };
        }
      },
    },
  });
  await mock.module('../../providers/workflowGeneration', {
    namedExports: {
      lockAgentWorkflowGeneration: async () => {
        assert(held);
      },
    },
  });
  const mutation = await import('../../domains/agents/repoWorkflowMutations');
  await mock.module('../../domains/agents/repo', {
    namedExports: {
      findAgentById: async () => {
        if (readThrows) throw new Error('synthetic observation failure');
        return clone();
      },
      updateAgentForWorkflow: mutation.updateAgentForWorkflow,
    },
  });
  await mock.module('../../providers/chat', {
    namedExports: {
      broadcastAgentUpdate: async (_id: string, value: Record<string, unknown>) => {
        events.push(value);
      },
      broadcastAgentModeStarted: async () => undefined,
    },
  });
  await mock.module('../../providers/logger', {
    namedExports: {
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
    },
  });
  await mock.module('../../providers/agentCleanup', {
    namedExports: { releaseAgentBrowserSessions: async () => undefined },
  });
  await mock.module('../../providers/credentialPropagation', {
    namedExports: { classifyAgentFailureForSurface: async () => null },
  });
  await mock.module('../../providers/purchaseCleanup', {
    namedExports: { cleanupAgentPurchaseCards: async () => undefined },
  });
  await mock.module('../../providers/traceArchiveLifecycle', {
    namedExports: { finalizeAgent: async () => undefined },
  });
  let persisted = true,
    rollback = true,
    rollbackCalls = 0;
  await mock.module('../../providers/workflowReplacementState', {
    namedExports: {
      recordWorkflowResumeIntent: async () => ({
        outcome: 'ready',
        workflowId: 'workflow',
        userId: 'user',
        replacementOwned: false,
        persistedActiveIntent: persisted,
        requiresCreditCheck: false,
      }),
      rollbackWorkflowResumeIntent: async () => {
        rollbackCalls++;
        if (rollback) row = { ...row, status: 'PAUSED' };
        return rollback;
      },
    },
  });
  await mock.module('../../providers/temporal', {
    namedExports: {
      getTemporalClient: async () => ({
        workflow: {
          getHandle: () => ({
            signal: async () => {
              throw new Error('synthetic outage');
            },
          }),
        },
      }),
      startAgentWorkflowExecution: async () => undefined,
    },
  });
  await mock.module('../../providers/credits', {
    namedExports: { getUserUsage: async () => ({ remaining: 1 }) },
  });
  await mock.module('../../domains/agents/agentConfigService', {
    namedExports: { updateAgentConfig: async () => undefined },
  });
  await mock.module('../../domains/agents/agentRestartService', {
    namedExports: {
      acknowledgeWorkflowReplacementBootstrap: async () => undefined,
      finalizeWorkflowReplacementBootstrap: async () => undefined,
      restartAgent: async () => undefined,
    },
  });
  await mock.module('../../domains/agents/agentExecutionMode', {
    namedExports: { normalizeWorldModelMode: () => null },
  });
  const status = await import('../../domains/agents/agentStatusService');
  const control = await import('../../domains/agents/agentControlService');
  let failures = 0;
  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      process.stdout.write('PASS ' + name + '\n');
    } catch (error) {
      failures++;
      process.stderr.write('FAIL ' + name + ' ' + String(error) + '\n');
    }
  }
  await check('locked worker revision stays coherent across later pause', async () => {
    pauseAfterCommit = true;
    await status.updateAgentStatus('agent', { status: 'ACTIVE' }, {}, 'workflow');
    assert.equal(row.status, 'PAUSED');
    assert.equal(row.userControlRevision, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'ACTIVE');
    assert.equal(events[0].userControlRevision, 0);
    events.length = 0;
    pauseAfterCommit = false;
  });
  await check('rejected generation returns row without broadcast', async () => {
    accepted = false;
    events.length = 0;
    const result = await status.updateAgentStatus('agent', { status: 'ACTIVE' }, {}, 'workflow');
    assert.equal(result?.status, row.status);
    assert.equal(events.length, 0);
    accepted = true;
  });
  await check('snapshot includes monotonic iteration offset under the same lock', async () => {
    row.workflowIterationOffset = 9;
    const lower = await mutation.updateAgentForWorkflow('agent', 'workflow', {
      workflowIterationOffset: 3,
    });
    assert.equal(lower.accepted, true);
    assert.equal(lower.agent?.workflowIterationOffset, 9);
    const higher = await mutation.updateAgentForWorkflow('agent', 'workflow', {
      workflowIterationOffset: 12,
    });
    assert.equal(higher.agent?.workflowIterationOffset, 12);
  });
  await check('rollback broadcasts PAUSED and preserves public error', async () => {
    row = { ...row, status: 'ACTIVE', userControlRevision: 2 };
    events.length = 0;
    persisted = true;
    rollback = true;
    assert.deepEqual(await control.resumeAgent('agent'), {
      error: 'Cannot resume agent because its workflow is not running',
      status: 409,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'PAUSED');
    assert.equal(events[0].userControlRevision, 2);
  });
  await check('no rollback means no failed-resume broadcast', async () => {
    events.length = 0;
    persisted = false;
    const before = rollbackCalls;
    assert.deepEqual(await control.resumeAgent('agent'), {
      error: 'Cannot resume agent because its workflow is not running',
      status: 409,
    });
    assert.equal(rollbackCalls, before);
    assert.equal(events.length, 0);
  });
  await check('concurrent winner keeps success current-read path', async () => {
    persisted = true;
    rollback = false;
    events.length = 0;
    row = { ...row, status: 'ACTIVE', userControlRevision: 3 };
    assert.deepEqual(await control.resumeAgent('agent'), { success: true });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'ACTIVE');
    assert.equal(events[0].userControlRevision, 3);
  });
  await check('rollback observation failure never changes the public 409', async () => {
    persisted = true;
    rollback = true;
    readThrows = true;
    events.length = 0;
    try {
      assert.deepEqual(await control.resumeAgent('agent'), {
        error: 'Cannot resume agent because its workflow is not running',
        status: 409,
      });
      assert.equal(events.length, 0);
    } finally {
      readThrows = false;
    }
  });
  if (failures) process.exitCode = 1;
}
void main();
