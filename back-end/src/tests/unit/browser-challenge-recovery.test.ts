#!/usr/bin/env tsx
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import {
  buildPreferredBrowserConfig,
  browserRecoveryCandidates,
  compatiblePreferredBrowserConfig,
  pageLooksChallenged,
  probeCandidateBrowser,
  runParallelBrowserConfigSearch,
  type BrowserRecoveryConfig,
  type RecoveryCandidateSession,
} from '../../providers/browser/challengeRecovery';
import {
  createSessionWithContextUsingDependencies,
  type BrowserSessionCreationDependencies,
} from '../../providers/browser';
import { kernelCaptchaTelemetryConfig } from '../../providers/browser/captchaTelemetry';
import { buildSteelRecoveryBrowserOptions } from '../../providers/steel/session';
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
  const steelSource = readFileSync(
    new URL('../../providers/steel/session.ts', import.meta.url),
    'utf8'
  );
  const steelRecoveryFactory = steelSource.slice(
    steelSource.indexOf('export async function createSteelRecoverySession'),
    steelSource.indexOf(
      '/**\n * Close a browser session',
      steelSource.indexOf('createSteelRecoverySession')
    )
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

async function testPrefersPaymentCdnReachableWinnerWhenStablePassesTie(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(configs, {
    create: async (config) => fakeSession(config),
    probe: async (config) => ({
      stablePasses: 2,
      attempts: 2,
      // steel_managed is slower but payment-CDN reachable — must win over a
      // faster CF-only clear (Eventim card fields need js.stripe.com).
      latencyMs: config.key === 'steel_managed' ? 500 : 1,
      paymentCdnOk: config.key === 'steel_managed',
    }),
    promote: async (candidate) => {
      promoted.push(candidate.config.key);
    },
    release: async () => undefined,
  });
  assert.strictEqual(winner.config.key, 'steel_managed');
  assert.deepStrictEqual(promoted, ['steel_managed']);
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
}

async function testCandidateProbeUsesThePromotedDefaultContext(): Promise<void> {
  const cookies = [
    {
      name: 'authState',
      value: 'opaque',
      domain: '.order.online',
      path: '/',
    },
  ];
  let defaultPageVisits = 0;
  let disposablePageVisits = 0;
  let newContextCalls = 0;
  let defaultContextCloseCalls = 0;
  let browserCloseCalls = 0;
  const addedCookies: unknown[] = [];
  const initScripts: string[] = [];
  let originStorageRestores = 0;
  let originAuthVisible = false;

  const fakePage = (onVisit: () => void) => ({
    goto: async () => {
      onVisit();
      originAuthVisible = false;
      return { status: () => 200 };
    },
    waitForTimeout: async () => undefined,
    evaluate: async (pageFunction: () => Promise<unknown>) => {
      const source = Function.prototype.toString.call(pageFunction);
      if (source.includes('js.stripe.com')) {
        return true;
      }
      assert.ok(initScripts.some((script) => script.includes('signedInCart')));
      assert.strictEqual(
        typeof pageFunction,
        'function',
        'storage restore must be invoked as a page function'
      );
      const recoveryGlobal = globalThis as typeof globalThis & {
        __naviRestoreRecoveryStorage?: () => Promise<void>;
      };
      recoveryGlobal.__naviRestoreRecoveryStorage = async () => {
        originStorageRestores += 1;
        originAuthVisible = true;
      };
      try {
        await pageFunction();
      } finally {
        delete recoveryGlobal.__naviRestoreRecoveryStorage;
      }
      return undefined;
    },
    title: async () => {
      assert.ok(originAuthVisible, 'origin auth state must be restored before challenge probing');
      return 'Blue Bottle Coffee';
    },
    locator: () => ({ innerText: async () => 'Order drinks and pastries' }),
    content: async () => '<main>Order drinks and pastries</main>',
  });
  const defaultPage = fakePage(() => {
    defaultPageVisits += 1;
  });
  const disposablePage = fakePage(() => {
    disposablePageVisits += 1;
  });
  const defaultContext = {
    pages: () => [defaultPage],
    newPage: async () => defaultPage,
    addCookies: async (value: unknown[]) => {
      addedCookies.push(...value);
    },
    addInitScript: async (script: string) => {
      initScripts.push(script);
    },
    close: async () => {
      defaultContextCloseCalls += 1;
    },
  };
  const disposableContext = {
    newPage: async () => disposablePage,
    close: async () => undefined,
  };
  const browser = {
    contexts: () => [defaultContext],
    newContext: async () => {
      newContextCalls += 1;
      return disposableContext;
    },
    close: async () => {
      browserCloseCalls += 1;
    },
  } as unknown as Browser;
  const session = {
    ...fakeSession({ key: 'test', provider: 'kernel', proxyMode: 'isp' }),
    validationBrowser: browser,
  };

  const result = await probeCandidateBrowser(session, 'https://order.online/store/blue-bottle', {
    cookies,
    origins: [
      {
        origin: 'https://order.online',
        localStorage: [{ name: 'signedInCart', value: 'keep' }],
        indexedDB: [],
      },
    ],
  });

  assert.deepStrictEqual(addedCookies, cookies, 'full auth cookies must be loaded before probing');
  assert.strictEqual(newContextCalls, 0, 'the disposable incognito context is not promoted');
  assert.strictEqual(disposablePageVisits, 0);
  assert.strictEqual(defaultPageVisits, 2, 'the exact promoted context must pass twice');
  assert.strictEqual(initScripts.length, 1, 'origin state is installed on the promoted context');
  assert.strictEqual(originStorageRestores, 2, 'origin auth is awaited before both clean probes');
  assert.strictEqual(defaultContextCloseCalls, 0, 'the promoted context must remain alive');
  assert.strictEqual(browserCloseCalls, 1, 'only the validation CDP connection is closed');
  assert.deepStrictEqual(result, {
    stablePasses: 2,
    attempts: 2,
    latencyMs: result.latencyMs,
    paymentCdnOk: true,
  });
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
  });
  assert.deepStrictEqual(parsed.storage_state, { cookies: [], origins: [] });
  assert.strictEqual(
    recoverChallengeSchema.safeParse({
      task_id: '00000000-0000-4000-8000-000000000001',
      current_url: 'not-a-url',
      storage_state: { cookies: [], origins: [] },
    }).success,
    false
  );
}

async function main(): Promise<void> {
  testCandidateMatrix();
  testConfigSearchUsesHiddenRemoteSessionsOnly();
  await testParallelSearchPromotesStableFastestAndReleasesLosers();
  await testNoStableCandidateCleansEverything();
  await testPartialStableCandidateIsPromotedWhenNoneFullyStable();
  await testPrefersPaymentCdnReachableWinnerWhenStablePassesTie();
  testChallengeDetection();
  await testCandidateProbeUsesThePromotedDefaultContext();
  testPreferredConfigCompatibility();
  await testLearnedConfigSeedsTheNextSession();
  await testLearnedSteelFixedConfigSeedsTheNextSession();
  await testIncompatibleLearnedConfigFallsBackWithoutLeakingGeo();
  await testUnavailableLearnedConfigFallsBackToDeploymentDefault();
  testRecoveryRequestSchema();
  process.stdout.write('PASS staged browser challenge recovery\n');
}

void main();
