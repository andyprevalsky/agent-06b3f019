import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  let row = {
    id: 'agent',
    deletedAt: null,
    workflowReplacementToken: null as string | null,
    workflowReplacementState: null,
    statusMessage: null as string | null,
    userControlPaused: false,
    status: 'ACTIVE',
    userControlRevision: 0,
    temporalWorkflowId: 'workflow',
    userId: 'user',
    parentAgentId: null,
    updatedAt: new Date(),
    workflowIterationOffset: 9,
    tokenCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    messageCount: 0,
  };
  let held = false,
    pauseAfterCommit = false,
    accepted = true,
    readThrows = false,
    pauseBeforeLock = false,
    terminalBeforeLock = false;
  const events: Array<Record<string, unknown>> = [];
  const clone = () => ({ ...row });
  function matches(where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'NOT') return !matches(value as Record<string, unknown>);
      if (key === 'OR') return (value as Array<Record<string, unknown>>).some(matches);
      if (key === 'deletedAt') return value === null;
      if (value && typeof value === 'object' && 'notIn' in value)
        return !(value.notIn as unknown[]).includes((row as Record<string, unknown>)[key]);
      const current = (row as Record<string, unknown>)[key];
      if (value && typeof value === 'object' && 'gt' in value)
        return typeof current === 'number' && current > (value.gt as number);
      return current === value;
    });
  }
  const tx = {
    agent: {
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        assert(held);
        const applies = accepted && matches(where);
        if (applies) row = { ...row, ...data };
        return { count: applies ? 1 : 0 };
      },
      findFirst: async () => {
        assert(held);
        return clone();
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        assert(held);
        const next = Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key,
            value && typeof value === 'object' && 'increment' in value
              ? Number((row as Record<string, unknown>)[key]) + Number(value.increment)
              : value,
          ])
        );
        row = { ...row, ...next };
        return clone();
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
          if (pauseAfterCommit)
            row = { ...row, status: 'PAUSED', userControlRevision: 1, userControlPaused: true };
        }
      },
    },
  });
  await mock.module('../../providers/workflowGeneration', {
    namedExports: {
      lockAgentWorkflowGeneration: async () => {
        assert(held);
        if (terminalBeforeLock) row = { ...row, status: 'COMPLETED', userControlPaused: false };
        if (pauseBeforeLock)
          row = { ...row, status: 'PAUSED', userControlRevision: 1, userControlPaused: true };
      },
    },
  });
  const mutation = await import('../../domains/agents/repoWorkflowMutations');
  const intent = await import('../../providers/workflowReplacementControlState');
  const bootstrap = await import('../../providers/workflowReplacementBootstrapState');
  await mock.module('../../domains/agents/repo', {
    namedExports: {
      findAgentById: async () => {
        if (readThrows) throw new Error('synthetic observation failure');
        return clone();
      },
      updateAgentForWorkflow: mutation.updateAgentForWorkflow,
      updateAgent: async (_id: string, data: Record<string, unknown>) => {
        if (pauseBeforeLock)
          row = { ...row, status: 'PAUSED', userControlRevision: 1, userControlPaused: true };
        row = { ...row, ...data };
        return clone();
      },
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
  for (const generation of ['workflow', undefined]) {
    for (const queuedStatus of ['ACTIVE', 'STARTING_UP'] as const) {
      await check(
        `queued ${queuedStatus} cannot undo accepted pause (${generation ?? 'legacy'})`,
        async () => {
          row = { ...row, status: 'ACTIVE', userControlRevision: 0, userControlPaused: false };
          accepted = true;
          pauseAfterCommit = false;
          pauseBeforeLock = true;
          events.length = 0;
          try {
            const result = await status.updateAgentStatus(
              'agent',
              { status: queuedStatus },
              {},
              generation
            );
            assert.equal(result?.status, 'PAUSED');
            assert.equal(row.status, 'PAUSED');
            assert.equal(row.userControlRevision, 1);
            assert.equal(events.length, 0);
          } finally {
            pauseBeforeLock = false;
          }
        }
      );
    }
  }
  await check(
    'explicit resume, worker-only pause, terminal and accounting remain eligible',
    async () => {
      for (const generation of ['workflow', undefined]) {
        row = { ...row, status: 'PAUSED', userControlRevision: 0, userControlPaused: false };
        assert.equal(
          (await mutation.updateAgentForWorkflow('agent', generation, { status: 'ACTIVE' }))
            .accepted,
          true
        );
        row = { ...row, status: 'ACTIVE', userControlRevision: 2, userControlPaused: false };
        assert.equal(
          (await mutation.updateAgentForWorkflow('agent', generation, { status: 'STARTING_UP' }))
            .accepted,
          true
        );
        row = { ...row, status: 'PAUSED', userControlRevision: 3, userControlPaused: true };
        assert.equal(
          (await mutation.updateAgentForWorkflow('agent', generation, { ownCostCents: 7 }))
            .accepted,
          true
        );
        assert.equal(row.status, 'PAUSED');
        assert.equal(
          (await mutation.updateAgentForWorkflow('agent', generation, { status: 'COMPLETED' }))
            .accepted,
          true
        );
        assert.equal(row.status, 'COMPLETED');
      }
    }
  );
  await check(
    'old worker PAUSED after explicit resume cannot permanently fence later ACTIVE',
    async () => {
      for (const generation of ['workflow', undefined]) {
        row = { ...row, status: 'PAUSED', userControlRevision: 1, userControlPaused: true };
        await intent.recordWorkflowResumeIntent('agent');
        assert.equal(row.userControlPaused, false);
        assert.equal(row.userControlRevision, 2);
        const queuedPause = await mutation.updateAgentForWorkflow('agent', generation, {
          status: 'PAUSED',
        });
        assert.equal(queuedPause.accepted, true);
        const currentActive = await mutation.updateAgentForWorkflow('agent', generation, {
          status: 'ACTIVE',
        });
        assert.equal(currentActive.accepted, true);
        assert.equal(currentActive.agent?.status, 'ACTIVE');
        assert.equal(currentActive.agent?.userControlRevision, 2);
      }
    }
  );
  await check(
    'durable pause and failed resume rollback fence only current user intent',
    async () => {
      row = { ...row, status: 'ACTIVE', userControlRevision: 0, userControlPaused: false };
      await mutation.pauseAgentUnderWorkflowLock('agent');
      assert.equal(row.userControlPaused, true);
      await intent.recordWorkflowResumeIntent('agent');
      assert.equal(row.userControlPaused, false);
      assert.equal(
        await intent.rollbackWorkflowResumeIntent('agent', 'workflow', row.userControlRevision),
        true
      );
      assert.equal(row.userControlPaused, true);
      assert.equal(
        (await mutation.updateAgentForWorkflow('agent', 'workflow', { status: 'ACTIVE' })).accepted,
        false
      );
      assert.equal(
        (await mutation.updateAgentForWorkflow('agent', 'workflow', { status: 'COMPLETED' }))
          .accepted,
        true
      );
      assert.equal(row.userControlPaused, false);
    }
  );
  await check(
    'paused replacement bootstrap retains intent with or without restored state',
    async () => {
      for (const restored of [
        undefined,
        {
          status: 'ACTIVE' as const,
          progress: 0,
          tokenCount: 0,
          tokensIn: 0,
          tokensOut: 0,
          contextSize: 0,
          messageCount: 0,
        },
      ]) {
        row = {
          ...row,
          status: 'STARTING_UP',
          workflowReplacementToken: 'claim',
          userControlPaused: true,
        };
        const result = await bootstrap.finalizeWorkflowReplacementBootstrap(
          'agent',
          'workflow',
          restored
        );
        assert.equal(result.status, 'PAUSED');
        assert.equal(row.status, 'PAUSED');
        assert.equal(row.userControlPaused, true);
        assert.equal(row.workflowReplacementToken, null);
      }
    }
  );
  await check('Prisma status-operation envelopes cannot bypass accepted pause intent', async () => {
    for (const generation of ['workflow', undefined]) {
      for (const next of ['ACTIVE', 'STARTING_UP'] as const) {
        row = { ...row, status: 'PAUSED', userControlPaused: true };
        const result = await mutation.updateAgentForWorkflow('agent', generation, {
          status: { set: next },
        });
        assert.equal(result.accepted, false);
        assert.equal(row.status, 'PAUSED');
      }
    }
  });
  await check('terminal replacement state wins over stale pause intent', async () => {
    for (const terminal of ['COMPLETED', 'FAILED'] as const) {
      row = {
        ...row,
        status: terminal,
        workflowReplacementToken: 'claim',
        userControlPaused: true,
      };
      const result = await bootstrap.finalizeWorkflowReplacementBootstrap('agent', 'workflow');
      assert.equal(result.status, terminal);
      assert.equal(row.status, terminal);
      assert.equal(row.userControlPaused, false);
    }
  });
  await check('old failed resume cannot roll back a later pause/resume winner', async () => {
    row = {
      ...row,
      status: 'PAUSED',
      userControlPaused: true,
      userControlRevision: 1,
      workflowReplacementToken: null,
    };
    await intent.recordWorkflowResumeIntent('agent');
    await mutation.pauseAgentUnderWorkflowLock('agent');
    await intent.recordWorkflowResumeIntent('agent');
    assert.equal(row.userControlRevision, 4);
    assert.equal(await intent.rollbackWorkflowResumeIntent('agent', 'workflow', 2), false);
    for (const invalid of [NaN, -1, undefined]) {
      assert.equal(
        await intent.rollbackWorkflowResumeIntent('agent', 'workflow', invalid as number),
        false
      );
    }
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.userControlPaused, false);
    assert.equal(row.userControlRevision, 4);
  });
  await check(
    'terminal commit after service pre-read rejects every queued nonterminal status',
    async () => {
      for (const generation of ['workflow', undefined])
        for (const next of ['ACTIVE', 'STARTING_UP', 'PAUSED'] as const) {
          row = { ...row, status: 'ACTIVE', userControlPaused: false };
          events.length = 0;
          terminalBeforeLock = true;
          try {
            const result = await status.updateAgentStatus(
              'agent',
              { status: next },
              {},
              generation
            );
            assert.equal(result?.status, 'COMPLETED');
            assert.equal(events.length, 0);
          } finally {
            terminalBeforeLock = false;
          }
        }
    }
  );
  await check(
    'explicit raised cost limit resumes intent and advances control revision',
    async () => {
      row = {
        ...row,
        status: 'COST_LIMIT_REACHED',
        userControlPaused: true,
        userControlRevision: 1,
      };
      assert.equal(
        await mutation.updateAgentConfigMutation(
          'agent',
          { priceLimitCents: 100 },
          undefined,
          'workflow'
        ),
        true
      );
      assert.equal(row.status, 'ACTIVE');
      assert.equal(row.userControlPaused, false);
      assert.equal(row.userControlRevision, 2);
    }
  );
  await check('rollback broadcasts PAUSED and preserves public error', async () => {
    row = { ...row, status: 'ACTIVE', userControlRevision: 2, userControlPaused: false };
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
