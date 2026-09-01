#!/usr/bin/env tsx
/**
 * Browser challenge recovery unit tests (part 2) — split for max-lines.
 * Learned preferred-config seeding, request schemas, same-site URL helpers.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  buildPreferredBrowserConfig,
  compatiblePreferredBrowserConfig,
  sameSiteNavigationUrl,
} from '../../providers/browser/challengeRecovery';
import { closeValidationBrowser } from '../../providers/browser/challengeRecoverySupport';
import {
  buildChallengeClassifierMessages,
  challengeClassifierCostCents,
  CHALLENGE_LLM_MODEL,
  CHALLENGE_LLM_SYSTEM_PROMPT,
} from '../../providers/browser/challengeLlmClassifier';
import {
  createSessionWithContextUsingDependencies,
  type BrowserSessionCreationDependencies,
} from '../../providers/browser';
import {
  probeCookieVariantSchema,
  recoverChallengeSchema,
} from '../../domains/browser-session/types';

function testPreferredConfigCompatibility(): void {
  const preferred = {
    version: 1,
    provider: 'kernel',
    proxyMode: 'isp_city',
    kernelProxyType: 'isp',
    kernelSpecificity: 'city',
    proxyLocation: { country: 'US', state: 'CA', city: 'SAN FRANCISCO' },
    learnedAt: '2026-07-22T00:00:00.000Z',
  };
  assert.ok(
    compatiblePreferredBrowserConfig(preferred, {
      country: 'US',
      state: 'CA',
      city: 'SAN FRANCISCO',
    })
  );
  assert.strictEqual(
    compatiblePreferredBrowserConfig(preferred, { country: 'US', state: 'TX', city: 'DALLAS' }),
    null,
    'a cached config cannot override a new location constraint'
  );
}

function providerSession(provider: 'kernel' | 'steel') {
  return {
    provider,
    sessionId: `${provider}-session`,
    debugUrl: `https://${provider}.example/debug`,
    taskId: `${provider}-task`,
    wsUrl: `wss://${provider}.example/cdp`,
    proxySource: `${provider}-proxy`,
    proxyLocation: { country: 'US', state: 'CA', city: 'SAN FRANCISCO' },
    profileId: null,
    profileSource: 'test',
    validationBrowser: null,
  } as const;
}

function steelSession() {
  const session = providerSession('steel');
  return {
    sessionId: session.sessionId,
    debugUrl: session.debugUrl,
    taskId: session.taskId,
    wsUrl: session.wsUrl,
    proxySource: session.proxySource,
    proxyLocation: session.proxyLocation,
    steelProfileId: null,
    profileSource: session.profileSource,
    validationBrowser: null,
  };
}

async function testLearnedConfigSeedsTheNextSession(): Promise<void> {
  const location = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };
  const cached = buildPreferredBrowserConfig(
    {
      key: 'kernel_isp',
      provider: 'kernel',
      proxyMode: 'isp_city',
      kernelProxyType: 'isp',
      kernelSpecificity: 'city',
    },
    location
  );
  const kernelCalls: Parameters<BrowserSessionCreationDependencies['createKernel']>[] = [];
  let steelCalls = 0;
  const dependencies: BrowserSessionCreationDependencies = {
    readPreferredConfig: async () => cached,
    defaultProvider: () => 'steel',
    createKernel: async (...args) => {
      kernelCalls.push(args);
      return providerSession('kernel');
    },
    createSteel: async () => {
      steelCalls += 1;
      return steelSession();
    },
  };

  const session = await createSessionWithContextUsingDependencies(
    'context-1',
    'agent-1',
    location,
    'https://order.online/',
    { keepValidationConnection: true },
    dependencies
  );

  assert.strictEqual(session.provider, 'kernel');
  assert.strictEqual(kernelCalls.length, 1, 'the next session starts with the learned provider');
  assert.strictEqual(steelCalls, 0, 'the deployment default is not tried first');
  assert.deepStrictEqual(kernelCalls[0]?.[4], {
    keepValidationConnection: true,
    exactManagedProxy: { type: 'isp', specificity: 'city' },
  });
}

async function testLearnedSteelFixedConfigSeedsTheNextSession(): Promise<void> {
  const location = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };
  const cached = buildPreferredBrowserConfig(
    {
      key: 'steel_fixed',
      provider: 'steel',
      proxyMode: 'fixed',
      steelProxyMode: 'fixed',
    },
    location
  );
  let kernelCalls = 0;
  const steelCalls: Parameters<BrowserSessionCreationDependencies['createSteel']>[] = [];
  const dependencies: BrowserSessionCreationDependencies = {
    readPreferredConfig: async () => cached,
    defaultProvider: () => 'kernel',
    createKernel: async () => {
      kernelCalls += 1;
      return providerSession('kernel');
    },
    createSteel: async (...args) => {
      steelCalls.push(args);
      return steelSession();
    },
  };

  const session = await createSessionWithContextUsingDependencies(
    'context-1',
    'agent-1',
    location,
    undefined,
    undefined,
    dependencies
  );

  assert.strictEqual(session.provider, 'steel');
  assert.strictEqual(kernelCalls, 0);
  assert.strictEqual(steelCalls.length, 1);
  assert.deepStrictEqual(steelCalls[0]?.[4], { proxyMode: 'fixed' });
}

async function testIncompatibleLearnedConfigFallsBackWithoutLeakingGeo(): Promise<void> {
  const learnedLocation = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };
  const requestedLocation = { country: 'US', state: 'TX', city: 'DALLAS' };
  const cached = buildPreferredBrowserConfig(
    {
      key: 'kernel_isp',
      provider: 'kernel',
      proxyMode: 'isp_city',
      kernelProxyType: 'isp',
      kernelSpecificity: 'city',
    },
    learnedLocation
  );
  let kernelCalls = 0;
  const steelCalls: Parameters<BrowserSessionCreationDependencies['createSteel']>[] = [];
  const dependencies: BrowserSessionCreationDependencies = {
    readPreferredConfig: async () => cached,
    defaultProvider: () => 'steel',
    createKernel: async () => {
      kernelCalls += 1;
      return providerSession('kernel');
    },
    createSteel: async (...args) => {
      steelCalls.push(args);
      return { ...steelSession(), proxyLocation: requestedLocation };
    },
  };

  await createSessionWithContextUsingDependencies(
    'context-1',
    'agent-1',
    requestedLocation,
    undefined,
    undefined,
    dependencies
  );

  assert.strictEqual(kernelCalls, 0);
  assert.strictEqual(steelCalls.length, 1);
  assert.deepStrictEqual(steelCalls[0]?.[2], requestedLocation);
  assert.deepStrictEqual(steelCalls[0]?.[4], {});
}

async function testUnavailableLearnedConfigFallsBackToDeploymentDefault(): Promise<void> {
  const location = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };
  const cached = buildPreferredBrowserConfig(
    {
      key: 'steel_fixed',
      provider: 'steel',
      proxyMode: 'fixed',
      steelProxyMode: 'fixed',
    },
    location
  );
  const steelOptions: unknown[] = [];
  let kernelCalls = 0;
  const dependencies: BrowserSessionCreationDependencies = {
    readPreferredConfig: async () => cached,
    defaultProvider: () => 'kernel',
    createKernel: async () => {
      kernelCalls += 1;
      return providerSession('kernel');
    },
    createSteel: async (_contextId, _agentId, _location, _url, options) => {
      steelOptions.push(options);
      throw new Error('fixed proxy temporarily unavailable');
    },
  };

  const session = await createSessionWithContextUsingDependencies(
    'context-1',
    'agent-1',
    location,
    undefined,
    undefined,
    dependencies
  );

  assert.strictEqual(session.provider, 'kernel');
  assert.strictEqual(kernelCalls, 1);
  assert.deepStrictEqual(steelOptions, [{ proxyMode: 'fixed' }]);
}

function testRecoveryRequestSchema(): void {
  const parsed = recoverChallengeSchema.parse({
    task_id: '00000000-0000-4000-8000-000000000001',
    current_url: 'https://order.online/store/blue-bottle',
    storage_state: { cookies: [], origins: [] },
    user_agent: 'test-agent',
    blocked_resource_url: 'https://js.stripe.com/v3',
    require_payment_cdn: true,
  });
  assert.deepStrictEqual(parsed.storage_state, { cookies: [], origins: [] });
  assert.strictEqual(parsed.blocked_resource_url, 'https://js.stripe.com/v3');
  assert.strictEqual(parsed.require_payment_cdn, true);
  assert.strictEqual(
    recoverChallengeSchema.safeParse({
      task_id: '00000000-0000-4000-8000-000000000001',
      current_url: 'not-a-url',
      storage_state: { cookies: [], origins: [] },
    }).success,
    false
  );
  const cookieProbe = probeCookieVariantSchema.parse({
    task_id: '00000000-0000-4000-8000-000000000001',
    current_url: 'https://order.online/store/blue-bottle',
    storage_state: { cookies: [{ name: 'cf_clearance', value: 'x' }], origins: [] },
  });
  assert.strictEqual(cookieProbe.storage_state.cookies.length, 1);
  assert.strictEqual(
    probeCookieVariantSchema.safeParse({
      task_id: '00000000-0000-4000-8000-000000000001',
      current_url: 'https://order.online/store/blue-bottle',
    }).success,
    false
  );
  const routeSource = readFileSync(
    new URL('../../domains/browser-session/routes.challenge-recovery.ts', import.meta.url),
    'utf8'
  );
  assert.match(routeSource, /\/probe-cookie-variant/);
  assert.match(routeSource, /probeBrowserCookieVariant/);
}

function testSameSiteNavigationUrl(): void {
  const kabuki =
    'https://www.hotels.com/Hotel-Search?destination=Hotel%20Kabuki%2C%20San%20Francisco';
  const city = 'https://www.hotels.com/Hotel-Search?destination=San%20Francisco%2C%20California';
  assert.equal(sameSiteNavigationUrl(kabuki, city), city);
  assert.equal(
    sameSiteNavigationUrl(kabuki, 'https://hotels.com/Hotel-Search?destination=SF'),
    'https://hotels.com/Hotel-Search?destination=SF'
  );
  assert.equal(sameSiteNavigationUrl(kabuki, 'https://evil.example/x'), null);
  assert.equal(sameSiteNavigationUrl(kabuki, 'not-a-url'), null);
  assert.equal(sameSiteNavigationUrl(kabuki, ''), null);
}

function testClassifierMessagesSurfaceRecoveryReasonWithoutHardCdnPin(): void {
  // The model must still see the recovery reason and anti-screenshot-overfit
  // instructions without hard-pinned CDN wording in the user message block.
  assert.match(CHALLENGE_LLM_SYSTEM_PROMPT, /Critical anti-pattern/i);
  assert.match(
    CHALLENGE_LLM_SYSTEM_PROMPT,
    /Do NOT return challenged=false just because the screenshot looks like the real product site/i
  );

  const reason =
    'Checkout payment widget never mounted.\n' +
    'Blocked third-party resource that must become reachable/usable: https://js.stripe.com/v3/';
  const messages = buildChallengeClassifierMessages({
    url: 'https://www.doordash.com/checkout',
    title: 'DoorDash',
    status: 200,
    cleanedDom: 'Checkout  Subtotal  Place Order',
    networkSummary: 'status=200 80ms https://www.doordash.com/graphql',
    screenshotBase64Png: null,
    recoveryReason: reason,
  });
  const user = messages.find((m) => m.role === 'user');
  assert.ok(user);
  const text =
    typeof user!.content === 'string'
      ? user!.content
      : (user!.content as Array<{ type: string; text?: string }>)
          .filter((part) => part.type === 'text')
          .map((part) => part.text || '')
          .join('\n');
  assert.match(text, /Agent recovery reason \(for context\):/i);
  assert.match(text, /https:\/\/js\.stripe\.com\/v3\//);
  assert.match(text, /visual context only/i);
}

function testChallengeLlmClassifierCostRouting(): void {
  assert.equal(CHALLENGE_LLM_MODEL, 'rose-labs/rose-1-mini');
  const paid = challengeClassifierCostCents({
    call_site: 'challenge_llm_classifier',
    prompt_tokens: 1_000,
    completion_tokens: 100,
    total_tokens: 1_100,
    actual_model: 'anthropic/claude-haiku-4.5',
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.ok(paid > 0, 'waterfall classifier usage must have positive cost');
  const free = challengeClassifierCostCents({
    call_site: 'challenge_llm_classifier',
    prompt_tokens: 1_000,
    completion_tokens: 100,
    total_tokens: 1_100,
    actual_model: 'claude-haiku-4-5-claude',
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(free, 0, 'direct compute-token classifier usage is $0');
}

async function testCloseValidationBrowserNeverBlocksRelease(): Promise<void> {
  await closeValidationBrowser({ validationBrowser: {} });
  await closeValidationBrowser({ validationBrowser: null });
  await closeValidationBrowser({
    validationBrowser: {
      close: async () => {
        throw new Error('cdp already gone');
      },
    },
  });
  let closed = false;
  await closeValidationBrowser({
    validationBrowser: {
      close: async () => {
        closed = true;
      },
    },
  });
  assert.equal(closed, true);
}

async function main(): Promise<void> {
  testPreferredConfigCompatibility();
  await testCloseValidationBrowserNeverBlocksRelease();
  await testLearnedConfigSeedsTheNextSession();
  await testLearnedSteelFixedConfigSeedsTheNextSession();
  await testIncompatibleLearnedConfigFallsBackWithoutLeakingGeo();
  await testUnavailableLearnedConfigFallsBackToDeploymentDefault();
  testRecoveryRequestSchema();
  testSameSiteNavigationUrl();
  testClassifierMessagesSurfaceRecoveryReasonWithoutHardCdnPin();
  testChallengeLlmClassifierCostRouting();
  process.stdout.write('PASS staged browser challenge recovery part2\n');
}

void main();
