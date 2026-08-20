#!/usr/bin/env tsx
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import {
  buildPreferredBrowserConfig,
  browserRecoveryCandidates,
  challengeDetectionReason,
  compatiblePreferredBrowserConfig,
  isUsableDocumentTitle,
  pageLooksChallenged,
  recoveryConfigKeyForSession,
  runParallelBrowserConfigSearch,
  shouldPreferSteelForChallengeTarget,
  type BrowserRecoveryConfig,
  type RecoveryCandidateSession,
} from '../../providers/browser/challengeRecovery';
import {
  challengeClassifierCostCents,
  CHALLENGE_LLM_MODEL,
} from '../../providers/browser/challengeLlmClassifier';
import {
  createSessionWithContextUsingDependencies,
  type BrowserSessionCreationDependencies,
} from '../../providers/browser';
import { kernelCaptchaTelemetryConfig } from '../../providers/browser/captchaTelemetry';
import { buildSteelRecoveryBrowserOptions } from '../../providers/steel/sessionRecovery';
import { recoverChallengeSchema } from '../../domains/browser-session/types';

function fakeSession(config: BrowserRecoveryConfig): RecoveryCandidateSession {
  return {
    provider: config.provider,
    sessionId: `session-${config.key}`,
    debugUrl: `https://debug/${config.key}`,
    wsUrl: `wss://cdp/${config.key}`,
    proxySource: config.proxyMode,
    proxyLocation: { country: 'US', state: 'CA', city: 'SAN FRANCISCO' },
    profileId: null,
    profileSource: 'challenge_candidate_ephemeral',
    validationBrowser: {} as Browser,
  };
}

function testCandidateMatrix(): void {
  const candidates = browserRecoveryCandidates({
    country: 'US',
    state: 'CA',
    city: 'SAN FRANCISCO',
  });
  assert.deepStrictEqual(
    candidates.map((candidate) => candidate.key),
    [
      'kernel_residential_city',
      'kernel_residential_state',
      'kernel_mobile',
      'kernel_isp',
      'steel_managed',
      'steel_fixed',
    ]
  );
  assert.deepStrictEqual(kernelCaptchaTelemetryConfig(), {
    enabled: true,
    browser: { captcha: { enabled: true } },
  });
  const steelOptions = buildSteelRecoveryBrowserOptions({
    proxy: { type: 'fixed', id: 'fixed:test' },
  });
  assert.strictEqual(steelOptions.solveCaptcha, true);
  assert.strictEqual(steelOptions.persistProfile, false);
  assert.deepStrictEqual(steelOptions.useProxy, { type: 'fixed', id: 'fixed:test' });
}

function testConfigSearchUsesHiddenRemoteSessionsOnly(): void {
  const source = readFileSync(
    new URL('../../providers/browser/challengeRecovery.ts', import.meta.url),
    'utf8'
  );
  const searchStart = source.indexOf('export async function searchAndPromoteBrowserConfig');
  assert.ok(searchStart >= 0, 'config-search composition root must exist');
  const searchSource = source.slice(searchStart);
  assert.match(searchSource, /dependencies\.createKernel/);
  assert.match(searchSource, /dependencies\.createSteel/);
  assert.match(searchSource, /browserSession\.updateMany/);
  assert.doesNotMatch(
    searchSource,
    /(?:browserSession|agent)\.create\s*\(/,
    'candidate search must not create child BrowserSession/Agent records (or browser chips)'
  );
  assert.doesNotMatch(
    searchSource,
    /saveBrowserActionMessage|message\.create\s*\(/,
    'candidate search must not emit a user-visible tool/chip per provider session'
  );

  const kernelSource = readFileSync(
    new URL('../../providers/browser/kernel.ts', import.meta.url),
    'utf8'
  );
  const kernelRemoteFactory = kernelSource.slice(
    kernelSource.indexOf('async function createRemoteSession'),
    kernelSource.indexOf('export async function createKernelSessionWithContext')
  );
  assert.doesNotMatch(
    kernelRemoteFactory,
    /browserSession\.create\s*\(/,
    'Kernel recovery candidates must remain remote-only'
  );
  const steelRecoveryFactory = readFileSync(
    new URL('../../providers/steel/sessionRecovery.ts', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(
    steelRecoveryFactory,
    /browserSession\.create\s*\(/,
    'Steel recovery candidates must remain remote-only'
  );
}

async function testParallelSearchPromotesStableFastestAndReleasesLosers(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US', state: 'CA', city: 'SAN FRANCISCO' });
  const created: string[] = [];
  const probed: string[] = [];
  const released: string[] = [];
  const promoted: string[] = [];
  let activeCreates = 0;
  let maxActiveCreates = 0;

  const winner = await runParallelBrowserConfigSearch(configs, {
    create: async (config) => {
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      await new Promise((resolve) => setTimeout(resolve, 0));
      created.push(config.key);
      activeCreates -= 1;
      return fakeSession(config);
    },
    probe: async (config) => {
      probed.push(config.key);
      if (config.key === 'kernel_mobile') {
        return { stablePasses: 1, attempts: 2, latencyMs: 1, paymentCdnOk: false };
      }
      return {
        stablePasses: 2,
        attempts: 2,
        latencyMs: config.key === 'steel_fixed' ? 10 : 100,
        paymentCdnOk: false,
      };
    },
    promote: async (candidate) => {
      promoted.push(candidate.config.key);
      assert.strictEqual(
        released.length,
        0,
        'winner is promoted before any live candidate is released'
      );
    },
    release: async (config) => {
      released.push(config.key);
    },
  });

  assert.strictEqual(
    maxActiveCreates,
    configs.length,
    'all provider browsers must spawn concurrently'
  );
  assert.deepStrictEqual(new Set(created), new Set(configs.map((candidate) => candidate.key)));
  assert.deepStrictEqual(new Set(probed), new Set(configs.map((candidate) => candidate.key)));
  assert.strictEqual(winner.config.key, 'steel_fixed');
  assert.deepStrictEqual(promoted, ['steel_fixed']);
  assert.strictEqual(released.length, configs.length - 1);
  assert.ok(!released.includes('steel_fixed'));
}

async function testNoStableCandidateCleansEverything(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' });
  const released: string[] = [];
  await assert.rejects(
    runParallelBrowserConfigSearch(configs, {
      create: async (config) => fakeSession(config),
      probe: async () => ({ stablePasses: 0, attempts: 2, latencyMs: 1, paymentCdnOk: false }),
      promote: async () => assert.fail('zero-pass candidate must never be promoted'),
      release: async (config) => {
        released.push(config.key);
      },
    }),
    /No stable browser configuration/
  );
  assert.strictEqual(released.length, configs.length);
}

async function testPartialStableCandidateIsPromotedWhenNoneFullyStable(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  const released: string[] = [];
  const winner = await runParallelBrowserConfigSearch(configs, {
    create: async (config) => fakeSession(config),
    probe: async (config) => ({
      stablePasses: config.key === 'kernel_mobile' ? 1 : 0,
      attempts: 2,
      latencyMs: config.key === 'kernel_mobile' ? 5 : 1,
      paymentCdnOk: false,
    }),
    promote: async (candidate) => {
      promoted.push(candidate.config.key);
    },
    release: async (config) => {
      released.push(config.key);
    },
  });
  assert.strictEqual(winner.config.key, 'kernel_mobile');
  assert.deepStrictEqual(promoted, ['kernel_mobile']);
  assert.strictEqual(released.length, configs.length - 1);
  assert.ok(!released.includes('kernel_mobile'));
}

function testRecoveryConfigKeyForSession(): void {
  assert.strictEqual(recoveryConfigKeyForSession('kernel', 'isp_city'), 'kernel_isp');
  assert.strictEqual(
    recoveryConfigKeyForSession('kernel', 'residential_city'),
    'kernel_residential_city'
  );
  assert.strictEqual(
    recoveryConfigKeyForSession('kernel', 'residential_country'),
    'kernel_residential_country'
  );
  assert.strictEqual(recoveryConfigKeyForSession('kernel', 'none'), 'kernel_direct');
  assert.strictEqual(recoveryConfigKeyForSession('steel', 'managed'), 'steel_managed');
  assert.strictEqual(recoveryConfigKeyForSession('steel', 'fixed'), 'steel_fixed');
  assert.strictEqual(recoveryConfigKeyForSession('kernel', 'mobile_city'), 'kernel_mobile');
}

function testChallengeDetection(): void {
  assert.ok(pageLooksChallenged({ status: 403, title: '', bodyText: '', html: '' }));
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Just a moment',
      bodyText: 'Please verify you are human',
      html: '',
    })
  );
  // Sparse body + challenge-platform script still counts as a wall.
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Store',
      bodyText: 'Coffee',
      html: '<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    })
  );
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Blue Bottle Coffee',
      bodyText: 'Order drinks and pastries',
      html: '<main>Menu</main>',
    })
  );
  assert.ok(
    pageLooksChallenged({
      status: null,
      title: '',
      bodyText: '',
      html: '<html><head></head><body></body></html>',
    })
  );
  // Eventim cleared ticket HTML embeds Turnstile + challenge-platform beside
  // real inventory — must not false-positive once body text is substantive.
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Buy tickets to LYNY in San Francisco on August 14, 2026',
      bodyText:
        'General Admission Tier 1 $25.00 Add to cart Select quantity and continue to checkout.',
      html:
        '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>' +
        '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>' +
        '<main>General Admission</main>',
    })
  );
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Access Denied',
      bodyText: 'You have been blocked. Access Denied. Ray ID a2685f1cff22d940.',
      html: '<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    })
  );
  // RCA: agent-payment-production-purchase (882509fd) — Kernel returns HTTP 502
  // with x-kernel-proxy-error: provider_blacklisted for checkout.stripe.com.
  // Without classifying that page as challenged, Kernel residential/ISP
  // candidates "win" the config search and recovery falsely reports success.
  assert.ok(
    pageLooksChallenged({
      status: 502,
      title: 'Bad Gateway',
      bodyText: 'Proxy error',
      html: '<html><body>Bad Gateway</body></html>',
    }),
    'HTTP 502 must count as challenged so Kernel blacklist exits cannot win'
  );
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Error',
      bodyText: 'Upstream refused: provider_blacklisted for this destination',
      html: '',
    }),
    'provider_blacklisted body text must count as challenged'
  );
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Proxy Error',
      bodyText: 'Blocked',
      html: '<html><body>x-kernel-proxy-error: provider_blacklisted</body></html>',
    }),
    'x-kernel-proxy-error HTML must count as challenged'
  );
  // Substantive merchant body + "just a moment" buried in a script/i18n bundle
  // must NOT false-positive — that discarded Stripe-capable exits.
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Buy tickets to LYNY',
      bodyText:
        'General Admission Tier 1 $25.00 Add to cart Select quantity and continue to checkout now.',
      html:
        '<script>window.__i18n={"errors":{"rate":"too many requests","cf":"just a moment","deny":"access denied"}}</script>' +
        '<main>General Admission</main>',
    }),
    'generic challenge prose in script bundles must not flag a cleared page'
  );

  // Soft-wall navigation shells (any vendor): empty / bare-hostname /
  // Loading-URL titles must not win probes even with long body text.
  const shellBody =
    'Boutique hotel description that already appears in meta/noscript while the soft-wall has not produced a real document title yet.';
  assert.ok(!isUsableDocumentTitle(''));
  assert.ok(!isUsableDocumentTitle('www.example.com'));
  assert.ok(!isUsableDocumentTitle('example.com'));
  assert.ok(!isUsableDocumentTitle('Loading https://www.example.com/rooms'));
  assert.ok(isUsableDocumentTitle('Boutique Hotel Near Downtown'));
  assert.strictEqual(
    challengeDetectionReason({
      status: null,
      title: '',
      bodyText: shellBody,
      html: '<main>shell</main>',
    }),
    'unusable_title'
  );
  assert.strictEqual(
    challengeDetectionReason({
      status: null,
      title: 'www.example.com',
      bodyText: shellBody,
      html: '<main>shell</main>',
    }),
    'unusable_title'
  );
  assert.strictEqual(
    challengeDetectionReason({
      status: null,
      title: 'Loading https://www.example.com/path',
      bodyText: shellBody,
      html: '<main>shell</main>',
    }),
    'unusable_title'
  );
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Boutique Hotel Near Downtown',
      bodyText: shellBody,
      html: '<main>Real inventory copy for rooms and rates.</main>',
    })
  );
}

function testSteelPreferredWhenCdnHardFilterActive(): void {
  assert.ok(
    !shouldPreferSteelForChallengeTarget('https://checkout.example.com/c/pay/cs_live_x')
  );
  assert.ok(
    shouldPreferSteelForChallengeTarget('https://checkout.example.com/c/pay/cs_live_x', {
      requirePaymentCdn: true,
    })
  );
  assert.ok(!shouldPreferSteelForChallengeTarget('https://www.example.com/shop'));
  assert.ok(!shouldPreferSteelForChallengeTarget('not-a-url'));

  const preferred = browserRecoveryCandidates(
    { country: 'US', state: 'CA', city: 'SAN FRANCISCO' },
    { preferSteel: true }
  );
  assert.deepStrictEqual(
    preferred.map((candidate) => candidate.key),
    ['steel_managed', 'steel_fixed']
  );
  assert.ok(preferred.every((candidate) => candidate.provider === 'steel'));
}


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

async function main(): Promise<void> {
  testCandidateMatrix();
  testConfigSearchUsesHiddenRemoteSessionsOnly();
  await testParallelSearchPromotesStableFastestAndReleasesLosers();
  await testNoStableCandidateCleansEverything();
  await testPartialStableCandidateIsPromotedWhenNoneFullyStable();
  // Payment-CDN / Stripe.js ranking + hard gates live in
  // browser-challenge-recovery-payment.test.ts (max-lines split).
  // Steel recovery city-drop retry: browser-challenge-recovery-steel.test.ts.
  testRecoveryConfigKeyForSession();
  testChallengeDetection();
  testChallengeLlmClassifierCostRouting();
  testSteelPreferredWhenCdnHardFilterActive();
  testPreferredConfigCompatibility();
  await testLearnedConfigSeedsTheNextSession();
  await testLearnedSteelFixedConfigSeedsTheNextSession();
  await testIncompatibleLearnedConfigFallsBackWithoutLeakingGeo();
  await testUnavailableLearnedConfigFallsBackToDeploymentDefault();
  testRecoveryRequestSchema();
  process.stdout.write('PASS staged browser challenge recovery\n');
}

void main();
