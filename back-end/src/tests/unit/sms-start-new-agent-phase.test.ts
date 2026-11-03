/**
 * SMS start_new_agent start_phase validation: only plan/execute are accepted,
 * and the chosen phase is carried on the queued op to the commit.
 */

import assert from 'node:assert/strict';

import { dispatchToolCall, type PendingOp } from '../../providers/smsSupervisor/supervisorTools';

async function testInvalidPhaseRejected(): Promise<void> {
  const pending: PendingOp[] = [];
  const result = await dispatchToolCall(
    {
      tool: 'start_new_agent',
      arguments: { goal: 'Order oat milk from Whole Foods', start_phase: 'chat' },
    },
    'unit-test-user',
    pending
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /start_phase must be 'plan' or 'execute'/);
  assert.equal(pending.length, 0);
}

async function testExecutePhaseQueued(): Promise<void> {
  const pending: PendingOp[] = [];
  const result = await dispatchToolCall(
    {
      tool: 'start_new_agent',
      arguments: {
        goal: 'Order oat milk from Whole Foods',
        start_phase: 'execute',
        notification_message: "I'll order your oat milk.",
      },
    },
    'unit-test-user',
    pending
  );
  assert.equal(result.success, true);
  assert.equal(pending.length, 1);
  const op = pending[0];
  assert.equal(op?.kind, 'start_new_agent');
  assert.equal(op.kind === 'start_new_agent' ? op.args.start_phase : undefined, 'execute');
  assert.equal(
    op.kind === 'start_new_agent' ? op.args.notification_message : undefined,
    "I'll order your oat milk."
  );
}

async function testInvalidNotificationRejected(): Promise<void> {
  const pending: PendingOp[] = [];
  const result = await dispatchToolCall(
    {
      tool: 'start_new_agent',
      arguments: { goal: 'Order oat milk', notification_message: 42 },
    },
    'unit-test-user',
    pending
  );
  assert.equal(result.success, false);
  assert.equal(pending.length, 0);
  const issues = JSON.parse(result.error ?? '[]') as Array<{
    code?: string;
    path?: unknown[];
    expected?: string;
    received?: string;
  }>;
  assert.ok(
    issues.some(
      (issue) =>
        issue.code === 'invalid_type' &&
        JSON.stringify(issue.path) === JSON.stringify(['arguments', 'notification_message']) &&
        issue.expected === 'string' &&
        issue.received === 'number'
    )
  );
}

async function testNullPhaseQueued(): Promise<void> {
  const pending: PendingOp[] = [];
  const result = await dispatchToolCall(
    {
      tool: 'start_new_agent',
      arguments: { goal: 'Research standing desks', start_phase: null },
    },
    'unit-test-user',
    pending
  );
  assert.equal(result.success, true);
  assert.equal(pending.length, 1);
}

async function main(): Promise<void> {
  const cases: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'unknown start_phase rejected', fn: testInvalidPhaseRejected },
    { name: 'execute start_phase queued on the op', fn: testExecutePhaseQueued },
    { name: 'null start_phase accepted (plan default)', fn: testNullPhaseQueued },
    { name: 'invalid notification rejected before queueing', fn: testInvalidNotificationRejected },
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
    process.stderr.write(`FAIL sms-start-new-agent-phase (${failed}/${cases.length} failed)\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS sms-start-new-agent-phase (${cases.length} cases)\n`);
}

void main();
