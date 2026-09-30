#!/usr/bin/env tsx
/**
 * Chat router stream-finalization regression.
 *
 * Owning boundary: providers/chat/routerDecision.ts →
 * finalizeRouterDecisionFromStream (the step that shapes a consumed
 * rose-1-flash router stream into a RouterDecision).
 *
 * Prod agent 6e645c29-4b6f-4d87-9478-22ecb28ebba5 (2026-09-30, MAC_APP create):
 *   Router Cerebras 429 → OpenRouter failover → 3s completion deadline with
 *   zero eligible structured items. routerLlm called
 *   StructuredOutputAccumulator.finalText() and
 *   StructuredOutputCardinalityError ("Expected one structured output item,
 *   received 0") escaped handleChatMessage → startChatMode
 *   failAgentIfStillActive. Agent FAILED in ~5s with no assistant message.
 *
 * Invariant: a zero-item / reasoning-only / deadline-expired empty stream
 * must NOT throw StructuredOutputCardinalityError. The seam returns
 * decision=null so the caller can use its existing empty/expired path.
 * Create-path chat failures persist an apology and do not mark FAILED.
 * No live server required.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
} from '../../providers/rose/structuredOutput';
import {
  finalizeRouterDecisionFromStream,
  parseRouterDecisionAfterDeadline,
} from '../../providers/chat/routerDecision';
import { recoverChatHandlerFailure } from '../../providers/chat/chatHandlerFailure';

const here = dirname(fileURLToPath(import.meta.url));

function testEmptyDeadlineDoesNotThrowCardinality(): void {
  const empty = new StructuredOutputAccumulator();
  assert.throws(
    () => empty.finalText(),
    StructuredOutputCardinalityError,
    'precondition: empty accumulator is the throwing zero-item state from prod'
  );
  assert.throws(
    () => parseRouterDecisionAfterDeadline(empty.finalText(), ''),
    StructuredOutputCardinalityError,
    'precondition: the pre-fix production call threw cardinality'
  );

  const result = finalizeRouterDecisionFromStream({
    structuredOutput: empty,
    accumulatedJson: '',
    deadlineExpired: true,
  });
  assert.equal(result.decision, null, 'empty+deadline must recover nothing, not throw');
  assert.equal(result.fullJson, '', 'empty+deadline has no JSON');
}

function testReasoningOnlyDoesNotThrowCardinality(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addText('The user wants nicotine patches and AirPods. I should escalate.', {
    item_id: 'reasoning:0',
    phase: 'reasoning',
  });
  assert.throws(
    () => acc.finalText(),
    StructuredOutputCardinalityError,
    'precondition: ignored-phase-only streams throw from finalText()'
  );

  const result = finalizeRouterDecisionFromStream({
    structuredOutput: acc,
    accumulatedJson: '',
    deadlineExpired: true,
  });
  assert.equal(result.decision, null, 'reasoning-only must not invent a route');
}

function testDeadlineRecoversPartialDirectAnswer(): void {
  const acc = new StructuredOutputAccumulator();
  const partial = '{"reasoning":"closed explanation","action":"direct_answer"';
  acc.addText(partial, { item_id: 'legacy:content:0', phase: 'unknown' });

  const result = finalizeRouterDecisionFromStream({
    structuredOutput: acc,
    accumulatedJson: partial,
    deadlineExpired: true,
  });
  assert.deepEqual(result.decision, {
    action: 'direct_answer',
    reasoning: 'closed explanation',
  });
}

function testCompleteStreamParsesWithoutDeadline(): void {
  const acc = new StructuredOutputAccumulator();
  const json =
    '{"reasoning":"this is a purchase","action":"start_superintelligence","goal":"buy nicotine patches and AirPods","mode":"plan"}';
  acc.addText(json, { item_id: 'legacy:content:0', phase: 'unknown' });

  const result = finalizeRouterDecisionFromStream({
    structuredOutput: acc,
    accumulatedJson: json,
    deadlineExpired: false,
  });
  assert.deepEqual(result.decision, {
    action: 'start_superintelligence',
    reasoning: 'this is a purchase',
    goal: 'buy nicotine patches and AirPods',
    mode: 'plan',
  });
}

async function testCreatePathChatFailureDoesNotFailAgent(): Promise<void> {
  const events: string[] = [];
  await recoverChatHandlerFailure({
    agentId: '6e645c29-4b6f-4d87-9478-22ecb28ebba5',
    error: new StructuredOutputCardinalityError('Expected one structured output item, received 0'),
    persistNotice: async () => {
      events.push('notice');
    },
  });
  assert.deepEqual(events, ['notice'], 'create-path chat failure must surface a notice');

  const lifecycle = readFileSync(
    join(here, '../../domains/agents/agentLifecycleService.ts'),
    'utf8'
  );
  assert.equal(
    lifecycle.includes('failAgentIfStillActive'),
    false,
    'startChatMode must not mark a new agent FAILED on a recoverable chat miss'
  );
}

async function main(): Promise<void> {
  testEmptyDeadlineDoesNotThrowCardinality();
  testReasoningOnlyDoesNotThrowCardinality();
  testDeadlineRecoversPartialDirectAnswer();
  testCompleteStreamParsesWithoutDeadline();
  await testCreatePathChatFailureDoesNotFailAgent();
  process.stdout.write('PASS chat-router-stream (5 cases)\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
