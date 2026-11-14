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
 * same regenerate contract — deadline misses included (prod agent e8f2279b,
 * 2026-10-01; the end-to-end replay lives in chat-router-failover.blackbox.ts).
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
import { ROUTER_JSON_SCHEMA } from '../../providers/chat/routerDecisionJsonSchema';
import {
  ChatLlmTransientMissError,
  MAX_CHAT_STRUCTURED_ATTEMPTS,
  regenerateOnChatStructuredMiss,
} from '../../providers/chat/chatStructuredRetry';
import { requireGeneratorParsedJson } from '../../providers/chat/generatorLlm';
import { DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS } from '../../providers/chat/routerCompletionDeadline';
import {
  accumulateChatLlmUsage,
  applyChunkUsage,
  emptyChatLlmUsage,
} from '../../providers/chat/routerLlm';

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

/**
 * The router serializes its fields in the schema's declared order. An
 * escalation stream cut off inside `queries` (FLAKY 6a3ec2af: the GLM failover
 * wrote search text there) must still carry a closed goal and mode, so the
 * deadline recovers the escalation instead of regenerating the turn.
 */
function testDeadlineRecoversEscalationCutInsideQueries(): void {
  const values: Record<string, unknown> = {
    reasoning: 'The user corrected the address to 88 Harlow St.',
    action: 'start_superintelligence',
    goal: 'Find the best hot yoga class this weekend near 88 Harlow St, San Francisco.',
    mode: 'plan',
    queries: ['hot yoga studios near 88 Harlow St', 'hot yoga schedule San Francisco'],
    grep: null,
  };
  const json = `{${Object.keys(ROUTER_JSON_SCHEMA.properties)
    .map((field) => `${JSON.stringify(field)}: ${JSON.stringify(values[field])}`)
    .join(', ')}}`;
  const cut = json.slice(0, json.indexOf('San Francisco"]'));
  assert.ok(cut.includes('"queries"'), 'precondition: the stream is cut inside queries');
  const acc = new StructuredOutputAccumulator();
  acc.addText(cut, { item_id: 'legacy:content:0', phase: 'unknown' });

  const result = finalizeRouterDecisionFromStream({
    structuredOutput: acc,
    accumulatedJson: cut,
    deadlineExpired: true,
  });
  assert.deepEqual(result.decision, {
    action: 'start_superintelligence',
    reasoning: values.reasoning,
    goal: values.goal,
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
  const webSearch = {
    decision: { action: 'web_search' as const, reasoning: 'search again', queries: ['manga'] },
    fullJson: '{}',
  };
  assert.throws(
    () =>
      requireRouterDecision({
        finalized: webSearch,
        deadlineExpired: false,
        stage: 'search_budget_spent',
      }),
    (error: unknown) => error instanceof ChatLlmTransientMissError && error.kind === 'parse',
    "a search after the turn's search rounds are spent is outside its schema: regenerate"
  );
  for (const stage of ['initial', 'after_search'] as const) {
    assert.equal(
      requireRouterDecision({ finalized: webSearch, deadlineExpired: false, stage }),
      webSearch.decision,
      `the ${stage} route may search`
    );
  }
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
  assert.equal(
    deadlineAttempts,
    MAX_CHAT_STRUCTURED_ATTEMPTS,
    'deadline misses regenerate like every other miss before any notice'
  );

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

function testUsageAccumulatesAcrossAttempts(): void {
  const usage = emptyChatLlmUsage();
  const first = emptyChatLlmUsage();
  applyChunkUsage(first, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    cache_read_input_tokens: 2,
  });
  accumulateChatLlmUsage(usage, first);
  const second = emptyChatLlmUsage();
  applyChunkUsage(second, {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
  });
  accumulateChatLlmUsage(usage, second);
  assert.equal(usage.prompt_tokens, 18);
  assert.equal(usage.completion_tokens, 7);
  assert.equal(usage.total_tokens, 25);
  assert.equal(usage.cache_read_input_tokens, 2);
}

function testPerAttemptBoundIsProfiled(): void {
  assert.equal(
    DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
    15_000,
    'the router attempt bound is sized from the long-context prod router profile; change it only with a new profile'
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
    router.indexOf('skipDemoCache = attempt > 1 && fcCacheWon', routerAttempt) > routerAttempt,
    'router must skip Fast Mode cache only after a cache-won miss'
  );
  assert.ok(
    router.indexOf('fcKey && fastModeRead && !skipDemoCache', routerAttempt) > routerAttempt,
    'router must still hedge Fast Mode cache after a live timeout'
  );
  assert.ok(
    router.indexOf('const attemptUsage = emptyChatLlmUsage()', routerAttempt) > routerAttempt,
    'router must snapshot usage per attempt instead of zeroing the shared totals'
  );
  assert.ok(
    router.indexOf('accumulateChatLlmUsage(usage, attemptUsage)', routerAttempt) > routerAttempt,
    'router must keep failed-attempt tokens in the billed total'
  );
  assert.ok(
    generator.indexOf('fcCacheWon = false', generatorAttempt) > generatorAttempt,
    'generator must drop a stale cache-winner flag before each attempt'
  );
  assert.ok(
    generator.indexOf('skipDemoCache = attempt > 1 && fcCacheWon', generatorAttempt) >
      generatorAttempt,
    'generator must skip Fast Mode cache only after a cache-won miss'
  );
  assert.ok(
    generator.indexOf('fcKey && fastModeRead && !skipDemoCache', generatorAttempt) >
      generatorAttempt,
    'generator must still hedge Fast Mode cache after a live timeout'
  );
  assert.ok(
    generator.indexOf('const attemptUsage = emptyChatLlmUsage()', generatorAttempt) >
      generatorAttempt,
    'generator must snapshot usage per attempt instead of zeroing the shared totals'
  );
  assert.ok(
    generator.indexOf('accumulateChatLlmUsage(usage, attemptUsage)', generatorAttempt) >
      generatorAttempt,
    'generator must keep failed-attempt tokens in the billed total'
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
  const requireDecision = router.indexOf('requireRouterDecision({ finalized, deadlineExpired');
  const deadlineClose = router.indexOf('!finalized.decision && deadlineExpired');
  assert.ok(
    deadlineClose > 0 && deadlineClose < requireDecision,
    'deadline miss must close open streams before throwing'
  );
  const closeWindow = router.slice(deadlineClose, requireDecision);
  assert.match(closeWindow, /'ERROR'/, 'deadline miss must ERROR any IN_PROGRESS web_search');
  assert.match(
    closeWindow,
    /clearOnDone: true/,
    'deadline miss must close ASSISTANT_STREAM so the thinking bubble does not hang'
  );
}

async function main(): Promise<void> {
  testEmptyDeadlineDoesNotThrowCardinality();
  testReasoningOnlyDoesNotThrowCardinality();
  testDeadlineRecoversPartialDirectAnswer();
  testCompleteStreamParsesWithoutDeadline();
  testDeadlineRecoversEscalationCutInsideQueries();
  testRequireRouterDecisionTypesEveryMiss();
  testRequireGeneratorParsedJsonTypesEveryMiss();
  await testFirstMissRegeneratesInsteadOfApologizing();
  await testExhaustedMissesStayTypedAndDoNotFailAgent();
  await testNonTransientErrorsDoNotRetry();
  testPerAttemptBoundIsProfiled();
  testCallSitesUseSharedRegenerate();
  testRetryResetsPerAttemptStreamState();
  testUsageAccumulatesAcrossAttempts();
  process.stdout.write('PASS chat-router-stream (14 cases)\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
