/**
 * Seatbelt: SMS start_new_agent budget_dollars is the agent-run LLM budget,
 * never the purchase amount.
 */

import assert from 'node:assert/strict';

import { dispatchToolCall, type PendingOp } from '../../providers/smsSupervisor/supervisorTools';

async function testPurchaseScaleBudgetRejected(): Promise<void> {
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

async function main(): Promise<void> {
  const cases: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'purchase-scale budget_dollars rejected', fn: testPurchaseScaleBudgetRejected },
    { name: 'agent-run budget_dollars accepted', fn: testAgentRunBudgetAccepted },
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
