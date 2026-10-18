#!/usr/bin/env tsx
/**
 * SMS Supervisor stream-finalization regression suite.
 *
 * Owning boundary: providers/smsSupervisor/supervisorHandler.ts →
 * finalizeSupervisorResponse (the step that shapes a consumed rose-1-flash
 * stream into a SupervisorResponse).
 *
 * Regression under test (prod incident 2026-07-19, user 5824c58c texting
 * "where can I get chicken wings near me"):
 *   rose-1-flash returned a reasoning-only / empty structured response — zero
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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
} from '../../providers/rose/structuredOutput';
import { SUPERVISOR_FALLBACK_MESSAGE } from '../../providers/smsSupervisor/supervisorHandler';
import {
  finalizeSupervisorResponse,
  finalizeSupervisorReactionResponse,
  type SupervisorResponse,
} from '../../providers/smsSupervisor/supervisorLlm';
import { isSingleEmoji } from '../../providers/smsSupervisor/inboundReaction';
import {
  setSupervisorFixtureOverride,
  clearSupervisorFixtureOverride,
  loadBlackboxSupervisorResponseFixture,
  BYPASS_FIXTURE_REAL_LLM,
} from '../../providers/smsSupervisor/supervisorFixtures';
import {
  callWithRetries,
  dispatchToolSafely,
} from '../../providers/smsSupervisor/supervisorResilience';
import {
  dispatchToolCall,
  type PendingOp,
  type ToolCall,
} from '../../providers/smsSupervisor/supervisorTools';
import { buildNativeToolFeedbackMessages } from '../../providers/smsSupervisor/environmentMessages';
import { unknownSupervisorToolError } from '../../providers/smsSupervisor/supervisorTools.helpers';
import { SmsSupervisorToolCallSchema } from '../../providers/smsSupervisor/schema';

const noSleep = async (): Promise<void> => {};

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

/**
 * A nonconforming structured-output provider can omit the schema-required
 * reasoning field while still returning usable tool calls. Logging must not
 * turn that usable response into a retry/fallback failure.
 */
function testStructuredAnswerWithoutReasoningPassesThrough(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addChunk({
    kind: 'content',
    data: {
      text: JSON.stringify({
        tool_calls: [{ tool: 'send_user_message', arguments: { message: 'Red' } }],
      }),
      item_id: 'final-without-reasoning',
      output_index: 0,
      content_index: 0,
      phase: 'final_answer',
    },
  });

  const res = finalizeSupervisorResponse([], acc, '');
  assert.equal(res.reasoning, '', 'omitted reasoning should normalize to an empty string');
  assert.equal(res.tool_calls.length, 1, 'valid tool calls must survive omitted reasoning');
  assert.equal(res.tool_calls[0].arguments.message, 'Red');
}

/**
 * The captured photo failure returned six content bytes, no native tool calls,
 * and no structured reasoning. A primitive JSON answer must enter the normal
 * empty-tool nudge path instead of crashing the logger.
 */
function testPrimitiveStructuredAnswerNudgesInsteadOfThrowing(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addChunk({
    kind: 'content',
    data: {
      text: JSON.stringify('Red'),
      item_id: 'primitive-photo-answer',
      output_index: 0,
      content_index: 0,
      phase: 'final_answer',
    },
  });

  const res = finalizeSupervisorResponse([], acc, 'identified the photo color');
  // A primitive envelope is a parse failure, and the parse-failure path
  // deliberately preserves whatever reasoning already streamed rather than
  // discarding it — the retry round is better off with that context.
  assert.equal(
    res.reasoning,
    'identified the photo color',
    'a primitive envelope must keep the streamed reasoning for the retry round'
  );
  assertNudgeRetry(res, 'primitive structured photo answer');
}

/**
 * A transient LLM/stream throw (peer-closed mid-stream, socket timeout, a stray
 * 429) must NOT reach the user. callWithRetries retries the round and returns
 * the first success, so a blip that recovers on retry yields a real answer
 * instead of "Sorry, something went wrong".
 */
async function testLlmRetrySucceedsAfterTransientThrows(): Promise<void> {
  let calls = 0;
  const result = await callWithRetries(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('peer closed connection');
      return 'answered';
    },
    { attempts: 3, baseDelayMs: 1, sleep: noSleep }
  );
  assert.equal(result, 'answered', 'retry should return the first success');
  assert.equal(calls, 3, 'should have retried until the third attempt succeeded');
}

/**
 * When every attempt throws (LLM genuinely unreachable this round), callWithRetries
 * rethrows the LAST error after exhausting the budget — the loop catches it and
 * degrades to the seq-gated fallback rather than spinning forever.
 */
async function testLlmRetryRethrowsAfterExhaustion(): Promise<void> {
  let calls = 0;
  await assert.rejects(
    () =>
      callWithRetries(
        async () => {
          calls += 1;
          throw new Error(`down attempt ${calls}`);
        },
        { attempts: 3, baseDelayMs: 1, sleep: noSleep }
      ),
    /down attempt 3/,
    'should rethrow the last error after all attempts fail'
  );
  assert.equal(calls, 3, 'should have made exactly `attempts` calls');
}

/**
 * An aborted/superseded run must not burn its remaining retry attempts + backoff.
 * callWithRetries stops the instant the signal is aborted: an already-aborted
 * signal throws before the first attempt; a signal aborted after the first
 * failure is not retried.
 */
async function testLlmRetryStopsOnAbort(): Promise<void> {
  // (a) already aborted → never even calls fn
  const pre = new AbortController();
  pre.abort();
  let preCalls = 0;
  await assert.rejects(
    () =>
      callWithRetries(
        async () => {
          preCalls += 1;
          return 'unreachable';
        },
        { attempts: 3, baseDelayMs: 1, sleep: noSleep, signal: pre.signal }
      ),
    'an already-aborted signal must throw before calling fn'
  );
  assert.equal(preCalls, 0, 'fn must not run when the signal is already aborted');

  // (b) aborted after the first failure → no retry
  const mid = new AbortController();
  let midCalls = 0;
  await assert.rejects(
    () =>
      callWithRetries(
        async () => {
          midCalls += 1;
          mid.abort();
          throw new Error('transient');
        },
        { attempts: 3, baseDelayMs: 1, sleep: noSleep, signal: mid.signal }
      ),
    /transient/,
    'should surface the failure without retrying an aborted run'
  );
  assert.equal(midCalls, 1, 'must not retry after the run was aborted');
}

/**
 * A thrown tool/environment error (e.g. a Prisma blip in refreshEnvironmentSnapshot)
 * must become a failure ToolResult, not escape the loop into the generic apology.
 */
async function testDispatchToolSafelyConvertsThrowToFailure(): Promise<void> {
  const res = await dispatchToolSafely('get_environment', async () => {
    throw new Error('P2024 pool timeout');
  });
  assert.equal(res.success, false, 'thrown tool error must degrade to a failure result');
  assert.equal(res.tool, 'get_environment', 'tool name must be preserved for the model');
  assert.match(
    res.error ?? '',
    /P2024 pool timeout/,
    'error message must be surfaced to the model'
  );
}

/**
 * A tool that succeeds passes through untouched (no spurious failure wrapping).
 */
async function testDispatchToolSafelyPassesThroughSuccess(): Promise<void> {
  const res = await dispatchToolSafely('spawn_agent', async () => ({
    tool: 'spawn_agent',
    success: true,
    result: 'spawned',
  }));
  assert.equal(res.success, true, 'a successful tool result must pass through');
  assert.equal(res.result, 'spawned');
}

/**
 * Guard the last-resort line stays warm + actionable — never regresses back to
 * the bare "something went wrong" dead-end this whole change set removes.
 */
function testMalformedToolIsDroppedNotThrown(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addChunk({
    kind: 'content',
    data: {
      text: JSON.stringify({
        reasoning: 'mixed',
        tool_calls: [
          { tool: 'send_user_message', arguments: { message: 'ok' } },
          { tool: 'not_a_real_tool', arguments: {} },
        ],
      }),
      item_id: 'mixed-tools',
      output_index: 0,
      content_index: 0,
      phase: 'final_answer',
    },
  });
  const res = finalizeSupervisorResponse([], acc, 'mixed');
  assert.equal(res.tool_calls.length, 1);
  assert.equal(res.tool_calls[0].tool, 'send_user_message');
}

function testFinalizeUsesZodNotFinalText(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '../../providers/smsSupervisor/supervisorLlm.ts'), 'utf8');
  assert.equal(source.includes('.finalText()'), false, 'SMS finalize must not call finalText()');
  assert.match(source, /SmsSupervisorResponseSchema\.safeParse/);
  assert.match(source, /SmsSupervisorToolCallSchema\.safeParse/);
}

function testFallbackMessageStaysWarm(): void {
  assert.ok(SUPERVISOR_FALLBACK_MESSAGE.length > 0, 'fallback message must be non-empty');
  assert.doesNotMatch(
    SUPERVISOR_FALLBACK_MESSAGE,
    /something went wrong/i,
    'fallback must not regress to the bare "something went wrong" dead-end'
  );
}

async function testNativeArgumentsValidatedBeforeDispatch(): Promise<void> {
  const pending: PendingOp[] = [];
  const invalid: ToolCall = {
    tool: 'start_new_agent',
    id: 'native-invalid-budget',
    arguments: { goal: 'Offline fixture', budget_dollars: '1', start_phase: 'plan' },
  };
  const rejected = await dispatchToolCall(invalid, 'offline', pending);
  assert.equal(rejected.success, false);
  assert.match(rejected.error ?? '', /invalid_type/);
  assert.match(rejected.error ?? '', /budget_dollars/);
  assert.deepEqual(pending, [], 'invalid native arguments must not queue a write');

  const feedback = buildNativeToolFeedbackMessages({
    round: 0,
    toolCalls: [invalid],
    resultsByCall: new Map([[invalid, [rejected]]]),
    roundResults: [],
    guidance: '',
  });
  assert.equal(feedback[0].tool_calls?.[0].id, invalid.id);
  assert.equal(feedback[1].tool_call_id, invalid.id);
  assert.ok(String(feedback[1].content).includes(rejected.error!));

  const grep = SmsSupervisorToolCallSchema.options.find(
    (schema) => schema.shape.tool.value === 'grep'
  );
  assert.ok(grep);
  const grepArgs = Object.fromEntries(
    Object.keys(grep.shape.arguments.shape).map((key) => [key, null])
  );
  Object.assign(grepArgs, { pattern: 'fixture', source: 'messages', filters: 'null' });
  const badFilters = await dispatchToolCall(
    { tool: 'grep', arguments: grepArgs },
    'offline',
    pending
  );
  assert.equal(badFilters.success, false);
  assert.match(badFilters.error ?? '', /invalid_type/);
  assert.match(badFilters.error ?? '', /filters/);
  assert.doesNotMatch(badFilters.error ?? '', /filters\.0/);
  assert.deepEqual(pending, []);

  const args = { goal: 'Offline fixture', budget_dollars: 1, start_phase: 'plan' };
  const accepted = await dispatchToolCall(
    { tool: 'start_new_agent', arguments: args },
    'offline',
    pending
  );
  assert.equal(accepted.success, true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'start_new_agent');
  assert.deepEqual(pending[0].args, args);

  const unknown = await dispatchToolCall(
    { tool: 'spawn_agent', arguments: {} },
    'offline',
    pending
  );
  assert.equal(unknown.success, false);
  assert.equal(unknown.error, unknownSupervisorToolError('spawn_agent'));
  assert.equal(pending.length, 1);
}

function testAnySingleUnicodeEmoji(): void {
  for (const emoji of ['😢', '❤️', '🙏🏽', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🇯🇵', '1️⃣', '🏳️‍🌈', '🪼']) {
    assert.equal(isSingleEmoji(emoji), true, `accept ${emoji}`);
  }
  // Unicode 18 modifier bases must work even when Node's property tables lag.
  // Exercise every tone, standalone and inside the existing ZWJ grammar.
  for (const base of ['\u{1FAF9}', '\u{1FAFA}']) {
    for (let modifier = 0x1f3fb; modifier <= 0x1f3ff; modifier++) {
      const emoji = base + String.fromCodePoint(modifier);
      assert.equal(isSingleEmoji(emoji), true, `accept Unicode 18 modifier base ${emoji}`);
      assert.equal(isSingleEmoji(base + '\uFE0F' + String.fromCodePoint(modifier)), true);
      assert.equal(isSingleEmoji('👩🏽\u200D' + emoji), true, 'updated bases work in compounds');
    }
  }
  for (const invalid of [
    '',
    'hello',
    '🎉🎉',
    '😢🎉',
    'hello🎉',
    '1',
    '🇯',
    '👩‍',
    '🎉🏽',
    '😢\u0301',
    '😀\u0301',
    '\u{1FAF9}🏽🏽',
    '\u{1FAFA}\u200D',
    '\u{1FAF9}\u0301',
  ]) {
    assert.equal(isSingleEmoji(invalid), false, `reject ${JSON.stringify(invalid)}`);
  }
}

function testReactionOnlyOutputIsValidatedAsAWhole(): void {
  const reaction = { tool: 'react_to_message', arguments: { emoji: '👩🏽‍💻' } };
  const empty = new StructuredOutputAccumulator();
  assert.deepEqual(finalizeSupervisorReactionResponse([reaction], empty, '').tool_calls, [
    reaction,
  ]);
  const json = new StructuredOutputAccumulator();
  json.addText(JSON.stringify({ reasoning: '', tool_calls: [reaction] }));
  assert.deepEqual(finalizeSupervisorReactionResponse([], json, '').tool_calls, [reaction]);
  for (const invalid of [
    [],
    [reaction, reaction],
    [reaction, { tool: 'grep', arguments: { pattern: 'x' } }],
    [{ tool: 'react_to_message', arguments: { emoji: '🎉', extra: 'text' } }],
    [{ tool: 'send_user_message', arguments: { message: 'hi' } }],
  ]) {
    assert.deepEqual(finalizeSupervisorReactionResponse(invalid, empty, '').tool_calls, []);
    const content = new StructuredOutputAccumulator();
    content.addText(JSON.stringify({ reasoning: '', tool_calls: invalid }));
    assert.deepEqual(finalizeSupervisorReactionResponse([], content, '').tool_calls, []);
  }
}

function testReactionFixturePeekPreservesReplyCursor(): void {
  const previousCapture = process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND;
  process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
  const user = 'reaction-fixture-peek';
  try {
    setSupervisorFixtureOverride(
      user,
      JSON.stringify([
        {
          reasoning: 'first',
          reaction_emoji: '😢',
          delay_ms: 5000,
          tool_calls: [{ tool: 'attempt_completion', arguments: {} }],
        },
        {
          reasoning: 'second',
          reaction_emoji: '🎉',
          tool_calls: [{ tool: 'attempt_completion', arguments: {} }],
        },
      ])
    );
    for (let i = 0; i < 2; i++) {
      const peek = loadBlackboxSupervisorResponseFixture(user, true);
      assert.equal(peek?.response.tool_calls[0].arguments.emoji, '😢');
      assert.equal(peek?.delayMs, 0);
    }
    assert.equal(loadBlackboxSupervisorResponseFixture(user)?.response.reasoning, 'first');
    assert.equal(
      loadBlackboxSupervisorResponseFixture(user, true)?.response.tool_calls[0].arguments.emoji,
      '🎉'
    );
    assert.equal(loadBlackboxSupervisorResponseFixture(user)?.response.reasoning, 'second');
    setSupervisorFixtureOverride(user, BYPASS_FIXTURE_REAL_LLM);
    assert.equal(loadBlackboxSupervisorResponseFixture(user, true), null);
  } finally {
    clearSupervisorFixtureOverride(user);
    if (previousCapture === undefined) delete process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND;
    else process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = previousCapture;
  }
}

async function main(): Promise<void> {
  testAnySingleUnicodeEmoji();
  testReactionOnlyOutputIsValidatedAsAWhole();
  testReactionFixturePeekPreservesReplyCursor();
  testReasoningOnlyStreamDoesNotThrow();
  testIgnoredPhaseOnlyStreamDoesNotThrow();
  testAmbiguousMultiItemStreamDoesNotThrow();
  testNativeToolCallsPassThrough();
  testValidStructuredAnswerPassesThrough();
  testStructuredAnswerWithoutReasoningPassesThrough();
  testPrimitiveStructuredAnswerNudgesInsteadOfThrowing();
  await testLlmRetrySucceedsAfterTransientThrows();
  await testLlmRetryRethrowsAfterExhaustion();
  await testLlmRetryStopsOnAbort();
  await testDispatchToolSafelyConvertsThrowToFailure();
  await testDispatchToolSafelyPassesThroughSuccess();
  testMalformedToolIsDroppedNotThrown();
  testFinalizeUsesZodNotFinalText();
  testFallbackMessageStaysWarm();
  await testNativeArgumentsValidatedBeforeDispatch();
  console.log('PASS sms-supervisor-stream (19 cases)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
