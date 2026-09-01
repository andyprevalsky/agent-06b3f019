#!/usr/bin/env tsx
/**
 * Reasoning-only / empty rose-1-lite streams must not crash chat.
 * Official 4-worker chat-lifecycle (2026-08-31) marked agents FAILED after
 * StructuredOutputCardinalityError escaped routerLlm.finalText().
 *
 * Run: npx tsx src/tests/unit/structured-output-empty-fallback.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRetryableEmptyStructuredOutput } from '../../domains/agents/agentLifecycleService';
import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
  structuredTextOrFallback,
} from '../../providers/rose/structuredOutput';

function testEmptyFinalTextThrows(): void {
  const acc = new StructuredOutputAccumulator();
  assert.throws(() => acc.finalText(), StructuredOutputCardinalityError);
}

function testFallbackOnEmpty(): void {
  const acc = new StructuredOutputAccumulator();
  assert.equal(structuredTextOrFallback(acc, '{"action":"direct_answer"}'), '{"action":"direct_answer"}');
}

function testFallbackOnReasoningOnly(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addText('thinking', { phase: 'reasoning', item_id: 'r1' });
  assert.throws(() => acc.finalText(), StructuredOutputCardinalityError);
  assert.equal(structuredTextOrFallback(acc, '{"action":"web_search"}'), '{"action":"web_search"}');
}

function testPrefersStructuredText(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addText('{"action":"direct_answer"}', { phase: 'final_answer', item_id: 'c1' });
  assert.equal(
    structuredTextOrFallback(acc, '{"action":"web_search"}'),
    '{"action":"direct_answer"}'
  );
}

function testRetryableHelper(): void {
  assert.equal(
    isRetryableEmptyStructuredOutput(new Error('Expected one structured output item, received 0')),
    true
  );
  assert.equal(
    isRetryableEmptyStructuredOutput(new Error('Router LLM returned no content')),
    true
  );
  assert.equal(isRetryableEmptyStructuredOutput(new Error('pool timeout')), false);
}

function testRouterAndLifecycleWireTheFallback(): void {
  const router = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'routerLlm.ts'),
    'utf8'
  );
  const lifecycle = readFileSync(
    join(process.cwd(), 'src', 'domains', 'agents', 'agentLifecycleService.ts'),
    'utf8'
  );
  assert.ok(router.includes('structuredTextOrFallback'), 'router must not call bare finalText()');
  assert.equal(
    (router.match(/structuredOutput\.finalText\(\)/g) ?? []).length,
    0,
    'router must not call finalText() directly'
  );
  assert.ok(
    lifecycle.includes('isRetryableEmptyStructuredOutput'),
    'chat start must retry empty structured output instead of FAILING the agent'
  );
  assert.ok(
    lifecycle.includes('Chat handler retry after empty structured output'),
    'retry must be logged'
  );
  assert.ok(
    router.includes('tryParseCompleteRouterDecision(accumulatedJson)'),
    'router must leave the stream only after a complete JSON decision'
  );
  assert.ok(
    !router.includes('ROUTER_SOFT_RECOVERY_MS'),
    'must not recover a partial decision before the 4.5s deadline'
  );
}

function main(): void {
  testEmptyFinalTextThrows();
  testFallbackOnEmpty();
  testFallbackOnReasoningOnly();
  testPrefersStructuredText();
  testRetryableHelper();
  testRouterAndLifecycleWireTheFallback();
  process.stdout.write('structured-output empty fallback tests passed\n');
}

main();
