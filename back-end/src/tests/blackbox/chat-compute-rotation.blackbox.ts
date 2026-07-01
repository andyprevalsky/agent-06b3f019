#!/usr/bin/env tsx
/* eslint-disable no-console */

import {
  callWithChatComputeRotation,
  fetchChatComputeAuth,
  toChatComputeAuth,
  type ChatComputeAuth,
} from '../../providers/chat/computeRotation';
import type { ComputeCodeCredentialResult } from '../../providers/computeCredentials';
import { RoseAuthError, RoseRateLimitError } from '../../providers/rose';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      duration: Date.now() - start,
    };
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function token(
  type: 'claude' | 'gpt',
  suffix: string,
  source: 'user' | 'pool' = 'pool'
): ComputeCodeCredentialResult {
  return {
    type,
    accessToken: `${type}-token-${suffix}`,
    accountId: type === 'gpt' ? `acct-${suffix}` : undefined,
    source,
    userId: `owner-${suffix}`,
    poolTokenId: source === 'pool' ? `pool-${suffix}` : undefined,
  };
}

function authType(auth: ChatComputeAuth): string {
  return auth.computeToken?.type ?? 'waterfall';
}

async function testAuthErrorRotatesToGptBeforeWaterfall(): Promise<void> {
  const first = token('claude', 'a');
  const second = token('gpt', 'b');
  const invocations: Array<{ type: string; disableWaterfall: boolean }> = [];
  const marks: Array<{ type: string; reason: string }> = [];
  let fetches = 0;

  const attempt = await callWithChatComputeRotation({
    userId: 'user-1',
    agentId: 'agent-1',
    phase: 'router',
    initialAuth: toChatComputeAuth(first),
    maxRotations: 3,
    fetchToken: async () => {
      fetches += 1;
      return second;
    },
    markToken: async (failed, reason) => {
      marks.push({ type: failed.type, reason });
    },
    invoke: async (auth, options) => {
      invocations.push({ type: authType(auth), disableWaterfall: options.disableWaterfall });
      if (auth.computeToken?.type === 'claude') {
        throw new RoseAuthError('bad claude token', 401);
      }
      return `ok-${auth.computeToken?.type ?? 'waterfall'}`;
    },
  });

  assertEqual(attempt.result, 'ok-gpt', 'rotated GPT result used');
  assertEqual(attempt.auth.computeToken?.type, 'gpt', 'successful token returned to caller');
  assertEqual(attempt.usedWaterfall, false, 'waterfall not used before rotation');
  assertEqual(fetches, 1, 'fetched exactly one replacement token');
  assertEqual(marks.length, 1, 'marked failed token once');
  assertEqual(marks[0]?.type, 'claude', 'marked failed Claude token');
  assertEqual(marks[0]?.reason, 'auth_error', 'auth failure marked as auth_error');
  assertEqual(invocations.length, 2, 'initial direct call plus rotated direct call');
  assert(
    invocations.every((call) => call.disableWaterfall),
    'direct attempts disable waterfall'
  );
}

async function testRotationExhaustionAllowsWaterfallOnlyAfterBudget(): Promise<void> {
  const directTokens = [
    token('claude', 'a'),
    token('gpt', 'b'),
    token('claude', 'c'),
    token('gpt', 'd'),
  ];
  let fetchIndex = 1;
  const invocations: Array<{ type: string; disableWaterfall: boolean }> = [];
  const marks: string[] = [];

  const attempt = await callWithChatComputeRotation({
    userId: 'user-1',
    agentId: 'agent-1',
    phase: 'generator',
    initialAuth: toChatComputeAuth(directTokens[0]),
    maxRotations: 3,
    fetchToken: async () => directTokens[fetchIndex++] ?? null,
    markToken: async (failed, reason) => {
      marks.push(`${failed.type}:${reason}`);
    },
    invoke: async (auth, options) => {
      invocations.push({ type: authType(auth), disableWaterfall: options.disableWaterfall });
      if (auth.computeToken) {
        throw new RoseAuthError(`bad ${auth.computeToken.type} token`, 401);
      }
      return 'waterfall-result';
    },
  });

  assertEqual(attempt.result, 'waterfall-result', 'waterfall result returned after exhaustion');
  assertEqual(attempt.usedWaterfall, true, 'waterfall flag set');
  assertEqual(attempt.rotations, 3, 'three replacement fetches allowed after initial token');
  assertEqual(invocations.length, 5, 'four direct attempts then one waterfall attempt');
  assert(
    invocations.slice(0, 4).every((call) => call.disableWaterfall),
    'direct attempts disable waterfall'
  );
  assertEqual(invocations[4]?.type, 'waterfall', 'final attempt has no direct token');
  assertEqual(invocations[4]?.disableWaterfall, false, 'final attempt enables waterfall');
  assertEqual(marks.length, 4, 'all exhausted direct tokens marked');
}

async function testRateLimitMarksRateLimitThenRotates(): Promise<void> {
  const first = token('gpt', 'a');
  const second = token('claude', 'b');
  const marks: string[] = [];

  const attempt = await callWithChatComputeRotation({
    userId: 'user-1',
    agentId: 'agent-1',
    phase: 'router',
    initialAuth: toChatComputeAuth(first),
    maxRotations: 3,
    fetchToken: async () => second,
    markToken: async (failed, reason) => {
      marks.push(`${failed.type}:${reason}`);
    },
    invoke: async (auth) => {
      if (auth.computeToken?.type === 'gpt') {
        throw new RoseRateLimitError('rate limited', 429);
      }
      return auth.computeToken?.type ?? 'waterfall';
    },
  });

  assertEqual(attempt.result, 'claude', 'rotated Claude result used');
  assertEqual(marks[0], 'gpt:rate_limit', 'rate failure marked as rate_limit');
  assertEqual(attempt.usedWaterfall, false, 'waterfall not used for rate-limit rotation');
}

async function testForceWaterfallSkipsChatComputeLookup(): Promise<void> {
  const previous = process.env.CHAT_FORCE_WATERFALL;
  process.env.CHAT_FORCE_WATERFALL = 'true';
  try {
    const auth = await fetchChatComputeAuth('user-1');
    assertEqual(auth.computeToken, null, 'no direct token selected');
    assertEqual(auth.claudeToken, null, 'no Claude token selected');
    assertEqual(auth.gptToken, null, 'no GPT token selected');
  } finally {
    if (previous === undefined) {
      delete process.env.CHAT_FORCE_WATERFALL;
    } else {
      process.env.CHAT_FORCE_WATERFALL = previous;
    }
  }
}

async function main(): Promise<void> {
  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    {
      name: 'chat compute / auth_error rotates to GPT before waterfall',
      fn: testAuthErrorRotatesToGptBeforeWaterfall,
    },
    {
      name: 'chat compute / waterfall only after rotation budget exhausted',
      fn: testRotationExhaustionAllowsWaterfallOnlyAfterBudget,
    },
    {
      name: 'chat compute / rate-limit marks rate_limit then rotates',
      fn: testRateLimitMarksRateLimitThenRotates,
    },
    {
      name: 'chat compute / force waterfall skips direct token lookup',
      fn: testForceWaterfallSkipsChatComputeLookup,
    },
  ];

  const results: TestResult[] = [];
  for (const t of tests) {
    const result = await runTest(t.name, t.fn);
    results.push(result);
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name} (${result.duration}ms)`);
    if (!result.passed) console.log(`    ${result.error}`);
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('chat-compute-rotation.blackbox runner crashed:', err);
  process.exit(1);
});
