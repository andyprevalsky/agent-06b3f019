#!/usr/bin/env tsx
/**
 * Chat structured-output miss regression.
 *
 * Owning boundary: providers/chat/chatStructuredRetry.ts +
 * finalizeRouterDecisionFromStream / requireRouterDecision /
 * requireGeneratorParsedJson.
 *
 * Prod agent 6e645c29-4b6f-4d87-9478-22ecb28ebba5 (2026-09-30, MAC_APP create):
 *   Router Cerebras 429 → OpenRouter failover → 3s completion deadline with
 *   zero eligible structured items. routerLlm called
 *   StructuredOutputAccumulator.finalText() and
 *   StructuredOutputCardinalityError escaped handleChatMessage → startChatMode
 *   failAgentIfStillActive. Agent FAILED in ~5s with no assistant message.
 *
 * July 19 SMS already settled the class: empty / reasoning-only / unparseable
 * streams regenerate in place. An immediate apology or FAILED is giving up on
 * the first miss. Chat router, generator, and speculative commit must use the
 * same regenerate contract. The 3s per-attempt bound must not change.
 *
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
  requireRouterDecision,
} from '../../providers/chat/routerDecision';
import { recoverChatHandlerFailure } from '../../providers/chat/chatHandlerFailure';
import {
  ChatLlmTransientMissError,
  MAX_CHAT_STRUCTURED_ATTEMPTS,
  regenerateOnChatStructuredMiss,
} from '../../providers/chat/chatStructuredRetry';
import { requireGeneratorParsedJson } from '../../providers/chat/generatorLlm';
import { DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS } from '../../providers/chat/routerCompletionDeadline';

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

function testRequireRouterDecisionTypesEveryMiss(): void {
  const empty = { decision: null, fullJson: '' };
  assert.throws(
    () => requireRouterDecision({ finalized: empty, deadlineExpired: true }),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'deadline',
    'deadline without a decision is a typed regenerate miss'
  );
  assert.throws(
    () => requireRouterDecision({ finalized: empty, deadlineExpired: false }),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'empty',
    'empty stream is a typed regenerate miss'
  );
  assert.throws(
    () =>
      requireRouterDecision({
        finalized: { decision: null, fullJson: '{not-json' },
        deadlineExpired: false,
      }),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'parse',
    'unparseable stream is a typed regenerate miss'
  );
}

function testRequireGeneratorParsedJsonTypesEveryMiss(): void {
  assert.throws(
    () => requireGeneratorParsedJson(''),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'empty',
    'generator empty stream is a typed regenerate miss'
  );
  assert.throws(
    () => requireGeneratorParsedJson('{not-json'),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'parse',
    'generator unparseable stream is a typed regenerate miss'
  );
  assert.deepEqual(requireGeneratorParsedJson('{"reasoning":"r","response":"hello"}'), {
    reasoning: 'r',
    response: 'hello',
  });
  assert.throws(
    () => requireGeneratorParsedJson('{}'),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'parse',
    'JSON.parse of {} is not a healthy generator response'
  );
  assert.throws(
    () => requireGeneratorParsedJson('{"reasoning":"r","response":""}'),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'parse',
    'empty generator response field is a typed regenerate miss'
  );
}

async function testFirstMissRegeneratesInsteadOfApologizing(): Promise<void> {
  let attempts = 0;
  const decision = await regenerateOnChatStructuredMiss({
    callSite: 'chat_router',
    agentId: '6e645c29-4b6f-4d87-9478-22ecb28ebba5',
    attempt: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ChatLlmTransientMissError('empty', 'Router LLM returned no content');
      }
      return { action: 'direct_answer' as const, reasoning: 'second attempt' };
    },
  });
  assert.equal(attempts, 2, 'first empty stream must regenerate in place');
  assert.deepEqual(decision, { action: 'direct_answer', reasoning: 'second attempt' });
}

async function testExhaustedMissesStayTypedAndDoNotFailAgent(): Promise<void> {
  let emptyAttempts = 0;
  await assert.rejects(
    regenerateOnChatStructuredMiss({
      callSite: 'chat_generator',
      agentId: '6e645c29-4b6f-4d87-9478-22ecb28ebba5',
      attempt: async () => {
        emptyAttempts += 1;
        throw new ChatLlmTransientMissError('empty', 'Router LLM returned no content');
      },
    }),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'empty'
  );
  assert.equal(
    emptyAttempts,
    MAX_CHAT_STRUCTURED_ATTEMPTS,
    'empty/parse retry budget must be bounded'
  );

  let deadlineAttempts = 0;
  await assert.rejects(
    regenerateOnChatStructuredMiss({
      callSite: 'chat_router',
      agentId: '6e645c29-4b6f-4d87-9478-22ecb28ebba5',
      attempt: async () => {
        deadlineAttempts += 1;
        throw new ChatLlmTransientMissError('deadline', 'Chat router completion expired');
      },
    }),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'deadline'
  );
  assert.equal(deadlineAttempts, 1, 'deadline misses must not consume a second 3s bound');

  const events: string[] = [];
  await recoverChatHandlerFailure({
    agentId: '6e645c29-4b6f-4d87-9478-22ecb28ebba5',
    error: new ChatLlmTransientMissError(
      'empty',
      'Expected one structured output item, received 0'
    ),
    persistNotice: async () => {
      events.push('notice');
    },
  });
  assert.deepEqual(events, ['notice'], 'exhausted miss may surface a notice');

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

async function testNonTransientErrorsDoNotRetry(): Promise<void> {
  let attempts = 0;
  const boom = new Error('Agent not found');
  await assert.rejects(
    regenerateOnChatStructuredMiss({
      callSite: 'chat_router',
      agentId: 'agent',
      attempt: async () => {
        attempts += 1;
        throw boom;
      },
    }),
    (error: unknown) => error === boom
  );
  assert.equal(attempts, 1, 'non-transient errors must not consume the regenerate budget');
}

function testPerAttemptBoundUnchanged(): void {
  assert.equal(
    DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
    3_000,
    'retry must not raise the per-attempt 3s router bound'
  );
  assert.equal(MAX_CHAT_STRUCTURED_ATTEMPTS, 2, 'one regenerate, not an unbounded loop');
}

function testRetryResetsPerAttemptStreamState(): void {
  const router = readFileSync(join(here, '../../providers/chat/routerLlm.ts'), 'utf8');
  const generator = readFileSync(join(here, '../../providers/chat/generatorLlm.ts'), 'utf8');
  const routerAttempt = router.indexOf('attempt: async');
  assert.ok(routerAttempt >= 0, 'router must wrap the stream in regenerateOnChatStructuredMiss');
  assert.ok(
    router.indexOf("lastStreamedText = ''", routerAttempt) > routerAttempt,
    'router must clear lastStreamedText at the start of every attempt'
  );
  assert.ok(
    router.indexOf('createClosedRouterActionDetector', routerAttempt) > routerAttempt,
    'router must create a fresh closed-action detector per attempt'
  );
  assert.ok(
    router.indexOf("'ERROR'", routerAttempt) > routerAttempt,
    'router must close a stale IN_PROGRESS web_search before retrying'
  );
  const generatorAttempt = generator.indexOf('attempt: async');
  assert.ok(
    generatorAttempt >= 0,
    'generator must wrap the stream in regenerateOnChatStructuredMiss'
  );
  assert.ok(
    generator.indexOf("lastStreamedText = ''", generatorAttempt) > generatorAttempt,
    'generator must clear lastStreamedText at the start of every attempt'
  );
  assert.ok(
    generator.indexOf('createGeneratorAttentionLifecycle', generatorAttempt) > generatorAttempt,
    'generator must start a fresh attention lifecycle on regenerate'
  );
  assert.ok(
    router.indexOf('fcCacheWon = false', routerAttempt) > routerAttempt,
    'router must drop a stale cache-winner flag before each attempt'
  );
  assert.ok(
    router.indexOf('skipFastCache = attempt > 1 && fcCacheWon', routerAttempt) > routerAttempt,
    'router must skip Fast Mode cache only after a cache-won miss'
  );
  assert.ok(
    router.indexOf('fcKey && fastModeRead && !skipFastCache', routerAttempt) > routerAttempt,
    'router must still hedge Fast Mode cache after a live timeout'
  );
  assert.ok(
    router.indexOf('usage.prompt_tokens = 0', routerAttempt) > routerAttempt,
    'router must reset usage so a silent retry cannot keep the failed attempt'
  );
  assert.ok(
    generator.indexOf('fcCacheWon = false', generatorAttempt) > generatorAttempt,
    'generator must drop a stale cache-winner flag before each attempt'
  );
  assert.ok(
    generator.indexOf('skipFastCache = attempt > 1 && fcCacheWon', generatorAttempt) >
      generatorAttempt,
    'generator must skip Fast Mode cache only after a cache-won miss'
  );
  assert.ok(
    generator.indexOf('fcKey && fastModeRead && !skipFastCache', generatorAttempt) >
      generatorAttempt,
    'generator must still hedge Fast Mode cache after a live timeout'
  );
  assert.ok(
    generator.indexOf('usage.prompt_tokens = 0', generatorAttempt) > generatorAttempt,
    'generator must reset usage so a silent retry cannot keep the failed attempt'
  );
}

function testCallSitesUseSharedRegenerate(): void {
  const router = readFileSync(join(here, '../../providers/chat/routerLlm.ts'), 'utf8');
  const generator = readFileSync(join(here, '../../providers/chat/generatorLlm.ts'), 'utf8');
  const speculation = readFileSync(
    join(here, '../../providers/chat/earlyDirectGenerator.ts'),
    'utf8'
  );
  assert.match(router, /regenerateOnChatStructuredMiss/, 'router must regenerate in place');
  assert.match(router, /requireRouterDecision/, 'router must use the typed miss seam');
  assert.equal(
    router.includes('.finalText()'),
    false,
    'router must never call finalText() on a degrade path'
  );
  assert.match(generator, /regenerateOnChatStructuredMiss/, 'generator must regenerate in place');
  assert.match(generator, /requireGeneratorParsedJson/, 'generator must use the typed miss seam');
  assert.match(
    generator,
    /GeneratorResponseSchema/,
    'generator health check must be the Zod schema'
  );
  const decision = readFileSync(join(here, '../../providers/chat/routerDecision.ts'), 'utf8');
  assert.match(
    decision,
    /RouterDecisionSchema\.safeParse/,
    'router health check must be the Zod schema, not a hand-rolled switch'
  );
  assert.match(
    speculation,
    /isChatLlmTransientMiss/,
    'speculative commit must not kill the turn on a typed miss'
  );
  const handler = readFileSync(join(here, '../../providers/chat/chatHandler.ts'), 'utf8');
  assert.match(
    handler,
    /deadlineRouterFallback/,
    'router deadline must escalate execute/plan turns instead of leaving a null workflow'
  );
  const retry = readFileSync(join(here, '../../providers/chat/chatStructuredRetry.ts'), 'utf8');
  assert.match(
    retry,
    /miss\.kind === 'deadline'/,
    'deadline misses must not start a second 3s router bound'
  );
}

async function main(): Promise<void> {
  testEmptyDeadlineDoesNotThrowCardinality();
  testReasoningOnlyDoesNotThrowCardinality();
  testDeadlineRecoversPartialDirectAnswer();
  testCompleteStreamParsesWithoutDeadline();
  testRequireRouterDecisionTypesEveryMiss();
  testRequireGeneratorParsedJsonTypesEveryMiss();
  await testFirstMissRegeneratesInsteadOfApologizing();
  await testExhaustedMissesStayTypedAndDoNotFailAgent();
  await testNonTransientErrorsDoNotRetry();
  testPerAttemptBoundUnchanged();
  testCallSitesUseSharedRegenerate();
  testRetryResetsPerAttemptStreamState();
  process.stdout.write('PASS chat-router-stream (12 cases)\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
