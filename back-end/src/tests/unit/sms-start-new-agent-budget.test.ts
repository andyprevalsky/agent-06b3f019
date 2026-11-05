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
async function testBudgetCommitReportsOnlyAcknowledgedResume(): Promise<void> {
  const { commitIncreaseBudget } =
    await import('../../providers/smsSupervisor/supervisorTools.budget');
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

async function main(): Promise<void> {
  await mock.module('../../providers/database', {
    namedExports: {
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
          limit += 200;
          return [{ priceLimitCents: limit }];
        },
      },
    },
  });
  await mock.module('../../providers/temporal', {
    namedExports: {
      getTemporalClient: async () => ({
        workflow: {
          getHandle: () => ({
            signal: async () => {
              signalCount++;
              if (signalFails) throw Error('synthetic signal outage');
            },
          }),
        },
      }),
    },
  });

  const cases: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'purchase-scale budget_dollars rejected', fn: testPurchaseScaleBudgetRejected },
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
