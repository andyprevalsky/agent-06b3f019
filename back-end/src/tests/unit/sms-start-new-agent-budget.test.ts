/**
 * Seatbelt: SMS start_new_agent budget_dollars is the agent-run LLM budget,
 * never the purchase amount.
 */

import assert from 'node:assert/strict';

import { mock } from 'node:test';

import type { PendingOp } from '../../providers/smsSupervisor/supervisorTools';

async function testPurchaseScaleBudgetRejected(): Promise<void> {
  const { dispatchToolCall } = await import('../../providers/smsSupervisor/supervisorTools');
  const pending: PendingOp[] = [];
  const result = await dispatchToolCall(
    {
      tool: 'start_new_agent',
      arguments: { goal: 'Purchase Laneige Lip Glowy Balm from Amazon', budget_dollars: 15 },
    },
    'unit-test-user',
    pending
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /NOT the purchase price/);
  assert.equal(pending.length, 0);
}

async function testAgentRunBudgetAccepted(): Promise<void> {
  const { dispatchToolCall } = await import('../../providers/smsSupervisor/supervisorTools');
  const pending: PendingOp[] = [];
  const result = await dispatchToolCall(
    {
      tool: 'start_new_agent',
      arguments: { goal: 'Purchase lip balm from Amazon', budget_dollars: 1 },
    },
    'unit-test-user',
    pending
  );
  assert.equal(result.success, true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, 'start_new_agent');
}

let signalFails = false;
let signalCount = 0;
let limit = 100;
let status = 'COST_LIMIT_REACHED';
let workflowId: string | null = 'synthetic-workflow';
let committedStatus: string | undefined;
let committedWorkflowId: string | null | undefined;
let signalWorkflow: string | undefined;
let scopeEntries = 0;
let queryCalls = 0;
let ambiguousCommit = false;
async function testBudgetCommitReportsOnlyAcknowledgedResume(): Promise<void> {
  const { commitIncreaseBudget } =
    await import('../../providers/smsSupervisor/supervisorTools.budget');
  committedStatus = undefined;
  committedWorkflowId = undefined;
  for (const outcome of ['failed', 'missing', 'accepted', 'active']) {
    signalFails = outcome === 'failed';
    workflowId = outcome === 'missing' ? null : 'synthetic-workflow';
    status = outcome === 'active' ? 'ACTIVE' : 'COST_LIMIT_REACHED';
    signalCount = 0;
    limit = 100;
    const result = await commitIncreaseBudget({
      kind: 'increase_budget',
      agentId: 'synthetic-agent',
      args: { agent_id_or_prefix: 'synthetic', amount_dollars: 2 },
    });
    assert.equal(result.success, true, 'Committed budget must not be reported as failed');
    assert.equal(limit, 300);
    assert.match(result.result, /\$3\.00/);
    assert.equal(result.result.includes('agent resuming'), outcome === 'accepted', outcome);
    assert.equal(signalCount, outcome === 'missing' || outcome === 'active' ? 0 : 1);
    if (outcome === 'failed' || outcome === 'missing') assert.match(result.result, /not resumed/);
  }
}

async function testCommittedStateControlsResume(
  beforeStatus: string,
  afterStatus: string,
  afterWorkflow: string | null
): Promise<void> {
  status = beforeStatus;
  workflowId = 'old-workflow';
  committedStatus = afterStatus;
  committedWorkflowId = afterWorkflow;
  signalCount = 0;
  signalWorkflow = undefined;
  signalFails = false;
  limit = 100;
  const { commitIncreaseBudget } =
    await import('../../providers/smsSupervisor/supervisorTools.budget');
  const result = await commitIncreaseBudget({
    kind: 'increase_budget',
    agentId: 'synthetic-agent',
    args: { agent_id_or_prefix: 'synthetic', amount_dollars: 2 },
  });
  assert.equal(result.success, true);
  assert.equal(limit, 300);
  assert.match(result.result, /\$3\.00/);
  const shouldSignal = afterStatus === 'COST_LIMIT_REACHED' && afterWorkflow !== null;
  assert.equal(signalCount, shouldSignal ? 1 : 0);
  assert.equal(signalWorkflow, shouldSignal ? afterWorkflow : undefined);
  assert.equal(result.result.includes('agent resuming'), shouldSignal);
  if (afterStatus === 'COST_LIMIT_REACHED' && !afterWorkflow)
    assert.match(result.result, /not resumed/);
}

async function testAmbiguousCommitDoesNotSignalOrAutomaticallyReplay(): Promise<void> {
  status = 'COST_LIMIT_REACHED';
  workflowId = 'synthetic-workflow';
  committedStatus = undefined;
  committedWorkflowId = undefined;
  signalCount = scopeEntries = queryCalls = 0;
  limit = 100;
  ambiguousCommit = true;
  const { commitIncreaseBudget } =
    await import('../../providers/smsSupervisor/supervisorTools.budget');
  try {
    await assert.rejects(
      commitIncreaseBudget({
        kind: 'increase_budget',
        agentId: 'synthetic-agent',
        args: { agent_id_or_prefix: 'synthetic', amount_dollars: 2 },
      }),
      /synthetic ambiguous commit/
    );
    assert.equal(scopeEntries, 1, 'non-idempotent update must opt out of automatic query replay');
    assert.equal(queryCalls, 1);
    assert.equal(limit, 300);
    assert.equal(signalCount, 0, 'uncertain update must not claim resumed');
  } finally {
    ambiguousCommit = false;
  }
}

async function main(): Promise<void> {
  await mock.module('../../providers/database', {
    namedExports: {
      withoutQueryRetry: async <T>(operation: () => Promise<T>): Promise<T> => {
        scopeEntries++;
        return await operation();
      },
      prisma: {
        agent: {
          findFirst: async () => ({
            id: 'synthetic-agent',
            goal: 'Synthetic budget task',
            priceLimitCents: limit,
            treeCostCents: 100,
            status,
            temporalWorkflowId: workflowId,
          }),
        },
        $queryRaw: async () => {
          queryCalls++;
          limit += 200;
          if (ambiguousCommit)
            throw Object.assign(new Error('synthetic ambiguous commit'), { code: 'P1017' });
          return [
            {
              priceLimitCents: limit,
              status: committedStatus ?? status,
              temporalWorkflowId:
                committedWorkflowId === undefined ? workflowId : committedWorkflowId,
            },
          ];
        },
      },
    },
  });
  await mock.module('../../providers/temporal', {
    namedExports: {
      getTemporalClient: async () => ({
        workflow: {
          getHandle: (id: string) => {
            signalWorkflow = id;
            return {
              signal: async () => {
                signalCount++;
                if (signalFails) throw Error('synthetic signal outage');
              },
            };
          },
        },
      }),
    },
  });

  const cases: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'purchase-scale budget_dollars rejected', fn: testPurchaseScaleBudgetRejected },
    {
      name: 'committed transition to cost limit uses current workflow',
      fn: () => testCommittedStateControlsResume('ACTIVE', 'COST_LIMIT_REACHED', 'new-workflow'),
    },
    {
      name: 'committed active status does not signal stale paused workflow',
      fn: () => testCommittedStateControlsResume('COST_LIMIT_REACHED', 'ACTIVE', 'new-workflow'),
    },
    {
      name: 'committed missing workflow truthfully reports not resumed',
      fn: () => testCommittedStateControlsResume('ACTIVE', 'COST_LIMIT_REACHED', null),
    },
    {
      name: 'ambiguous committed update opts out and never signals',
      fn: testAmbiguousCommitDoesNotSignalOrAutomaticallyReplay,
    },
    { name: 'agent-run budget_dollars accepted', fn: testAgentRunBudgetAccepted },
    {
      name: 'committed budget truthfully reports resume outcome',
      fn: testBudgetCommitReportsOnlyAcknowledgedResume,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    try {
      await testCase.fn();
      process.stdout.write(`  PASS  ${testCase.name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `  FAIL  ${testCase.name} -- ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  if (failed > 0) {
    process.stderr.write(`FAIL sms-start-new-agent-budget (${failed}/${cases.length} failed)\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS sms-start-new-agent-budget (${cases.length} cases)\n`);
}

void main();
