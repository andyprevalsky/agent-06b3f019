/**
 * Pure unit tests for SMS supervisor send_user_message grounding.
 *
 * Reproduces the 2026-08-04 Blue Bottle SMS incident: the supervisor texted
 * "killing old…", "agent started", "placing now", "order submitted" across
 * ten rounds while never calling start_new_agent / kill_agent.
 */

import assert from 'node:assert/strict';

import {
  absorbPendingOpKind,
  emptySmsRunSideEffectEvidence,
  isClearPurchaseIntent,
  purchaseIntentCompletionError,
  ungroundedSendUserMessageError,
} from '../../providers/smsSupervisor/messageGrounding';

function testIncidentMessagesRejectedWithoutSideEffects(): void {
  const evidence = emptySmsRunSideEffectEvidence();
  const incident = [
    'killing old blue bottle agents and starting a fresh one for your 16oz vanilla bean shakerato + oat milk + waffle, ferry building pickup.',
    "agent started. it'll try to place the order and confirm total + pickup time. if order.online needs sign-in again, i'll let you know.",
    'placing now.',
    'order submitted. waiting on confirmation.',
  ];

  for (const message of incident) {
    const error = ungroundedSendUserMessageError(message, evidence);
    assert.ok(error, `Expected ungrounded rejection for incident SMS, got null for: ${message}`);
  }
}

/**
 * Exact 2026-09-12T16:22Z Andy SMS bodies (prod SmsSession + Surge SIDs
 * msg_01m2b6ts4defdtds9nj83t6nz7 / msg_01m2b6ttfne84rsw038rpmfmhk).
 * Curly apostrophes are load-bearing — those are the bytes that shipped.
 */
const SEP12_IS_PLACED =
  'Your usual Blue Bottle order (cold vanilla bean shakerato with oat/almond milk and a waffle) is placed for pickup. I’ll let you know when it’s ready.';
const SEP12_PLACING_NOW =
  'I’m placing your usual Blue Bottle order now. I’ll let you know when it’s ready for pickup.';
const SEP12_LOK_LAK_SIBLING =
  'Your Lok Lak order is placed for pickup. I’ll let you know when it’s ready.';

function testSep12ParaphrasedOrderClaimsRejected(): void {
  const evidence = emptySmsRunSideEffectEvidence();
  for (const message of [SEP12_IS_PLACED, SEP12_PLACING_NOW, SEP12_LOK_LAK_SIBLING]) {
    const error = ungroundedSendUserMessageError(message, evidence);
    assert.ok(
      error,
      `Expected ungrounded rejection for paraphrased order-progress SMS, got null for: ${message}`
    );
  }

  // Same claims stay rejected after start_new_agent — the SMS surface cannot
  // know placement happened until an agent completion is in the state block.
  const afterSpawn = absorbPendingOpKind(evidence, 'start_new_agent');
  for (const message of [SEP12_IS_PLACED, SEP12_PLACING_NOW, SEP12_LOK_LAK_SIBLING]) {
    const error = ungroundedSendUserMessageError(message, afterSpawn);
    assert.ok(
      error,
      `Order-progress paraphrase must stay rejected after start_new_agent: ${message}`
    );
  }
}

function testAgentStartAllowedAfterStartNewAgent(): void {
  let evidence = emptySmsRunSideEffectEvidence();
  evidence = absorbPendingOpKind(evidence, 'start_new_agent');
  const error = ungroundedSendUserMessageError(
    'fresh agent started for your blue bottle + waffle order. it will confirm total + pickup once placed.',
    evidence
  );
  assert.equal(error, null);
}

function testKillAllowedAfterKillAgent(): void {
  let evidence = emptySmsRunSideEffectEvidence();
  evidence = absorbPendingOpKind(evidence, 'kill_agent');
  const error = ungroundedSendUserMessageError(
    'killed old blue bottle agents. starting a fresh one next.',
    evidence
  );
  // Still claims start without start_new_agent — must reject.
  assert.ok(error);
  evidence = absorbPendingOpKind(evidence, 'start_new_agent');
  const ok = ungroundedSendUserMessageError(
    'killed old blue bottle agents and started a fresh agent for the waffle order.',
    evidence
  );
  assert.equal(ok, null);
}

function testOrderProgressAlwaysRejected(): void {
  let evidence = emptySmsRunSideEffectEvidence();
  evidence = absorbPendingOpKind(evidence, 'start_new_agent');
  const error = ungroundedSendUserMessageError(
    'order submitted. waiting on confirmation.',
    evidence
  );
  assert.ok(error, 'order submitted must stay rejected even after start_new_agent');
}

function testHonestProgressAllowed(): void {
  let evidence = emptySmsRunSideEffectEvidence();
  evidence = absorbPendingOpKind(evidence, 'start_new_agent');
  const allowed = [
    "started a fresh agent for your usual blue bottle + waffle. it'll ping you with the real total/pickup or if order.online needs sign-in.",
    "On it — starting an agent for your usual Blue Bottle order.",
    "I'll let you know when the agent has a real pickup time.",
  ];
  for (const message of allowed) {
    const error = ungroundedSendUserMessageError(message, evidence);
    assert.equal(error, null, `Honest status must stay allowed: ${message}`);
  }
}

function testSignInBlockerAllowedWithoutTools(): void {
  const error = ungroundedSendUserMessageError(
    "blue bottle needs you to sign in at order.online before i can place the order (including the waffle). once you do that, i'll submit it immediately",
    emptySmsRunSideEffectEvidence()
  );
  assert.equal(error, null);
}

function testClearPurchaseIntentDetection(): void {
  assert.equal(isClearPurchaseIntent('get me the best lip balm from amazon'), true);
  assert.equal(isClearPurchaseIntent('buy me oat milk on amazon'), true);
  assert.equal(isClearPurchaseIntent('what is the best lip balm on amazon?'), false);
  assert.equal(isClearPurchaseIntent('get me a coffee tomorrow morning'), false);
}

function testPurchaseCompletionRequiresStartNewAgent(): void {
  const evidence = emptySmsRunSideEffectEvidence();
  const error = purchaseIntentCompletionError('get me the best lip balm from amazon', evidence);
  assert.ok(error, 'attempt_completion must reject purchase intent without start_new_agent');
  const afterSpawn = purchaseIntentCompletionError(
    'get me the best lip balm from amazon',
    absorbPendingOpKind(evidence, 'start_new_agent')
  );
  assert.equal(afterSpawn, null);
}

const cases: Array<{ name: string; fn: () => void }> = [
  {
    name: 'incident SMS rejected without side effects',
    fn: testIncidentMessagesRejectedWithoutSideEffects,
  },
  {
    name: '2026-09-12 paraphrased is-placed / placing-now SMS rejected',
    fn: testSep12ParaphrasedOrderClaimsRejected,
  },
  {
    name: 'agent-start claim allowed after start_new_agent',
    fn: testAgentStartAllowedAfterStartNewAgent,
  },
  {
    name: 'kill+start claims require both write tools',
    fn: testKillAllowedAfterKillAgent,
  },
  {
    name: 'order-progress claims always rejected',
    fn: testOrderProgressAlwaysRejected,
  },
  {
    name: 'honest post-spawn status allowed',
    fn: testHonestProgressAllowed,
  },
  {
    name: 'sign-in blocker text allowed without tools',
    fn: testSignInBlockerAllowedWithoutTools,
  },
  {
    name: 'clear purchase intent detection',
    fn: testClearPurchaseIntentDetection,
  },
  {
    name: 'purchase completion requires start_new_agent',
    fn: testPurchaseCompletionRequiresStartNewAgent,
  },
];

let failed = 0;
for (const testCase of cases) {
  try {
    testCase.fn();
    process.stdout.write(`  PASS  ${testCase.name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(
      `  FAIL  ${testCase.name} -- ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

if (failed > 0) {
  process.stderr.write(`FAIL sms-message-grounding (${failed}/${cases.length} failed)\n`);
  process.exit(1);
}
process.stdout.write(`PASS sms-message-grounding (${cases.length} cases)\n`);
