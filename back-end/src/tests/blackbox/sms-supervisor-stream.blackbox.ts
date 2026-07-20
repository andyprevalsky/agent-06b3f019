#!/usr/bin/env tsx
/**
 * SMS Supervisor stream-finalization regression suite.
 *
 * Owning boundary: providers/smsSupervisor/supervisorHandler.ts →
 * finalizeSupervisorResponse (the step that shapes a consumed rose-1-lite
 * stream into a SupervisorResponse).
 *
 * Regression under test (prod incident 2026-07-19, user 5824c58c texting
 * "where can I get chicken wings near me"):
 *   rose-1-lite returned a reasoning-only / empty structured response — zero
 *   native tool_calls AND zero emittable content items. The handler called
 *   StructuredOutputAccumulator.finalText() OUTSIDE its own "never send raw
 *   garbage to the user" try/catch, so a StructuredOutputCardinalityError
 *   ("Expected one structured output item, received 0") propagated up through
 *   handleSmsSupervisorMessage, crashing the supervisor turn. The user got
 *   "Sorry, something went wrong." with nothing committed.
 *
 * Invariant: a zero-item / ignored-phase-only / ambiguous-multi-item stream
 * must NOT throw. finalizeSupervisorResponse returns an EMPTY tool_calls
 * response, which routes into the supervisor loop's existing nudge-and-retry
 * ("No tool calls and no attempt_completion" → re-prompt); if every round
 * stays empty the loop's terminal net delivers one friendly apology. This
 * replaces the crash (StructuredOutputCardinalityError escaping the turn) AND
 * avoids giving up on the first transient empty stream. No live server required.
 */

import assert from 'node:assert/strict';

import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
} from '../../providers/rose/structuredOutput';
import {
  finalizeSupervisorResponse,
  type SupervisorResponse,
} from '../../providers/smsSupervisor/supervisorHandler';

/**
 * A no-actionable-output round must surface as an empty tool_calls response so
 * the supervisor loop nudges and retries — never a throw, and never an
 * immediate apology + attempt_completion that abandons the turn.
 */
function assertNudgeRetry(res: SupervisorResponse, label: string): void {
  assert.equal(
    res.tool_calls.length,
    0,
    `${label}: expected empty tool_calls (routes to loop nudge-retry), got tools=[${res.tool_calls
      .map((tc) => tc.tool)
      .join(', ')}]`
  );
}

/**
 * Aman's exact prod condition: the model emitted only reasoning — zero
 * tool_calls, zero content items in the accumulator.
 */
function testReasoningOnlyStreamDoesNotThrow(): void {
  const empty = new StructuredOutputAccumulator();
  // Sanity: this is genuinely the zero-item state that threw in prod.
  assert.throws(
    () => empty.finalText(),
    StructuredOutputCardinalityError,
    'precondition: an empty accumulator must be the throwing zero-item state'
  );

  const res = finalizeSupervisorResponse(
    [],
    empty,
    'The user is asking where to get chicken wings near them. I should search...'
  );
  assertNudgeRetry(res, 'reasoning-only (zero-item) stream');
}

/**
 * The prod trigger is often not a literally-empty accumulator but content whose
 * phase is ignored (commentary/reasoning) — select() filters those to zero
 * eligible items and throws on the same line. Prove that variant degrades too.
 */
function testIgnoredPhaseOnlyStreamDoesNotThrow(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addChunk({
    kind: 'content',
    data: {
      text: 'thinking out loud, no final answer',
      item_id: 'reasoning-1',
      output_index: 0,
      content_index: 0,
      phase: 'reasoning',
    },
  });
  assert.throws(
    () => acc.finalText(),
    StructuredOutputCardinalityError,
    'precondition: an ignored-phase-only accumulator must be a throwing zero-eligible state'
  );

  const res = finalizeSupervisorResponse([], acc, 'reasoning only');
  assertNudgeRetry(res, 'ignored-phase-only stream');
}

/**
 * Sibling failure the same fix must also kill: multiple final_answer items
 * (finalText throws "Expected one final_answer item, received 2").
 */
function testAmbiguousMultiItemStreamDoesNotThrow(): void {
  const acc = new StructuredOutputAccumulator();
  for (const [i, answer] of ['one', 'two'].entries()) {
    acc.addChunk({
      kind: 'content',
      data: {
        text: `{"answer":"${answer}"}`,
        item_id: `final-${i}`,
        output_index: i,
        content_index: 0,
        phase: 'final_answer',
      },
    });
  }
  assert.throws(
    () => acc.finalText(),
    StructuredOutputCardinalityError,
    'precondition: two final_answer items must be the throwing multi-item state'
  );

  const res = finalizeSupervisorResponse([], acc, 'ambiguous reasoning');
  assertNudgeRetry(res, 'ambiguous multi-item stream');
}

/**
 * The native-tool path (claudeAuth tool_use blocks) must pass through untouched.
 */
function testNativeToolCallsPassThrough(): void {
  const res = finalizeSupervisorResponse(
    [{ tool: 'get_environment', arguments: {} }],
    new StructuredOutputAccumulator(),
    'checking state'
  );
  assert.equal(res.tool_calls.length, 1, 'native tool call should pass through');
  assert.equal(res.tool_calls[0].tool, 'get_environment');
}

/**
 * Guard against over-correction: a real structured JSON answer must still be
 * parsed and passed through untouched (no spurious fallback).
 */
function testValidStructuredAnswerPassesThrough(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addChunk({
    kind: 'content',
    data: {
      text: JSON.stringify({
        reasoning: 'answering',
        tool_calls: [{ tool: 'send_user_message', arguments: { message: 'Try Wingstop on 5th.' } }],
      }),
      item_id: 'final-1',
      output_index: 0,
      content_index: 0,
      phase: 'final_answer',
    },
  });

  const res = finalizeSupervisorResponse([], acc, 'answering');
  assert.equal(res.tool_calls.length, 1, 'valid answer should not gain a fallback tool');
  assert.equal(res.tool_calls[0].tool, 'send_user_message');
  assert.equal(res.tool_calls[0].arguments.message, 'Try Wingstop on 5th.');
}

function main(): void {
  testReasoningOnlyStreamDoesNotThrow();
  testIgnoredPhaseOnlyStreamDoesNotThrow();
  testAmbiguousMultiItemStreamDoesNotThrow();
  testNativeToolCallsPassThrough();
  testValidStructuredAnswerPassesThrough();
  console.log('PASS sms-supervisor-stream (5 cases)');
}

main();
