#!/usr/bin/env tsx
/**
 * Payment-CDN / Stripe.js ranking + probe gates for challenge recovery.
 * Companion to browser-challenge-recovery.test.ts (keeps each file under max-lines).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import {
  boundedRecoveryResponseText,
  browserRecoveryCandidates,
  paymentCdnFocusedCandidates,
  probeCandidateBrowser,
  recoverySearchPlan,
  runLaneConfigSearch,
  runParallelBrowserConfigSearch,
  type BrowserRecoveryConfig,
  type RecoveryCandidateSession,
} from '../../providers/browser/challengeRecovery';
import { alternateProviderFirst } from '../../providers/browser/challengeRecoveryCandidates';

function testTransportFailureTriesAlternateProviderBeforeSameProviderTiers(): void {
  const configs = browserRecoveryCandidates({ country: 'US', state: 'CA', city: 'SAN FRANCISCO' });
  const reordered = alternateProviderFirst(configs, 'kernel');
  assert.deepStrictEqual(
    reordered.map((config) => config.key),
    [
      'steel_fixed',
      'steel_managed',
      // The raw catalog includes Browser Use; production drops it while the
      // rollout flag is off (availableBrowserRecoveryCandidates).
      'browser_use_residential_country',
      'tilion_residential',
      'tilion_mobile',
      'tilion_direct',
      ...configs.filter((config) => config.provider === 'kernel').map((config) => config.key),
    ]
  );
  assert.deepStrictEqual(
    [...reordered].sort((a, b) => a.key.localeCompare(b.key)),
    [...configs].sort((a, b) => a.key.localeCompare(b.key))
  );
}

async function testUnfinishedNetworkBodyDoesNotBlockRecoveryProbe(): Promise<void> {
  const stuck = new Promise<string>(() => undefined);
  assert.strictEqual(await boundedRecoveryResponseText({ text: () => stuck }, 5), undefined);
  assert.strictEqual(await boundedRecoveryResponseText({ text: async () => 'ready' }, 5), 'ready');
}

async function testTransportCandidateDeadlineReachesNextProvider(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' }).slice(0, 2);
  const released: string[] = [];
  let firstSignal: AbortSignal | undefined;
  const winner = await runLaneConfigSearch(
    configs,
    [{ key: 'default', storageState: {} }],
    {
      create: async (config) => fakeSession(config),
      probe: async (config, _session, _lane, signal) => {
        if (config.key === configs[0]!.key) {
          firstSignal = signal;
          await new Promise<void>(() => undefined);
        }
        return { stablePasses: 1, attempts: 1, latencyMs: 1, paymentCdnOk: true };
      },
      promote: async () => undefined,
      release: async (config) => {
        released.push(config.key);
      },
    },
    { candidateDeadlineMs: 10 }
  );
  assert.strictEqual(winner.config.key, configs[1]!.key);
  assert.strictEqual(firstSignal?.aborted, true);
  assert.deepStrictEqual(released, [configs[0]!.key]);
}

async function testTransportSearchDeadlineCancelsAllLanesBeforeHttpTimeout(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' }).slice(0, 1);
  const released: string[] = [];
  const promoted: string[] = [];
  let probeSignal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(
    runLaneConfigSearch(
      configs,
      [{ key: 'default', storageState: {} }],
      {
        create: async (config) => fakeSession(config),
        probe: async (_config, _session, _lane, signal) => {
          probeSignal = signal;
          await new Promise<void>(() => undefined);
          return { stablePasses: 1, attempts: 1, latencyMs: 1, paymentCdnOk: true };
        },
        promote: async (winner) => {
          promoted.push(winner.config.key);
        },
        release: async (config) => {
          released.push(config.key);
        },
      },
      { candidateDeadlineMs: 200, searchDeadlineMs: 10 }
    ),
    /Challenge recovery search deadline exceeded/
  );
  assert.ok(Date.now() - started < 150);
  assert.strictEqual(probeSignal?.aborted, true);
  assert.deepStrictEqual(promoted, []);
  assert.deepStrictEqual(released, [configs[0]!.key]);
}

async function testFailedPromotionHonorsExpiredSearchDeadline(): Promise<void> {
  const config = browserRecoveryCandidates({ country: 'US' })[0]!;
  const released: string[] = [];
  await assert.rejects(
    runLaneConfigSearch(
      [config],
      [{ key: 'default', storageState: {} }],
      {
        create: async () => fakeSession(config),
        probe: async () => ({ stablePasses: 1, attempts: 1, latencyMs: 1 }),
        promote: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('promotion failed');
        },
        release: async (_config, session) => {
          released.push(session.sessionId);
        },
      },
      { searchDeadlineMs: 5 }
    ),
    /Challenge recovery search deadline exceeded/
  );
  assert.deepStrictEqual(released, [fakeSession(config).sessionId]);
}

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

function testPaymentCdnFocusedSearchPlanSkipsAvoidAndKernelsFirst(): void {
  // k=4 thrash: sticky requirePaymentCdn re-probed all Kernel exits (CF-clear,
  // Stripe.js=false) while Steel was the only paymentCdnOk survivor — multiplying
  // concurrent provider sessions. Focus Steel first and never avoid under the
  // payment-CDN hard filter (avoided exit is usually that Steel winner).
  const configs = browserRecoveryCandidates({
    country: 'US',
    state: 'CA',
    city: 'SAN FRANCISCO',
  });
  const focused = paymentCdnFocusedCandidates(configs);
  assert.ok(focused.length > 0);
  assert.ok(focused.every((config) => config.provider === 'steel'));
  assert.ok(focused.some((config) => config.key === 'steel_managed'));

  const cfOnly = recoverySearchPlan({
    configs,
    requirePaymentCdn: false,
    avoidConfigKey: 'steel_managed',
  });
  assert.strictEqual(cfOnly.length, 1);
  assert.strictEqual(cfOnly[0]?.label, 'full');
  assert.strictEqual(cfOnly[0]?.avoidConfigKey, 'steel_managed');
  assert.strictEqual(cfOnly[0]?.configs.length, configs.length);

  const payment = recoverySearchPlan({
    configs,
    requirePaymentCdn: true,
    avoidConfigKey: 'steel_managed',
  });
  assert.strictEqual(payment.length, 2);
  assert.strictEqual(payment[0]?.label, 'payment_cdn_steel');
  assert.strictEqual(payment[0]?.avoidConfigKey, undefined);
  assert.deepStrictEqual(
    payment[0]?.configs.map((config) => config.key),
    focused.map((config) => config.key)
  );
  assert.strictEqual(payment[1]?.label, 'payment_cdn_full');
  assert.strictEqual(payment[1]?.avoidConfigKey, undefined);
  // Phase 2 must not re-probe Steel keys already tried in phase 1.
  assert.ok(
    (payment[1]?.configs ?? []).every((config) => config.provider !== 'steel'),
    'payment_cdn_full must exclude already-tried Steel candidates'
  );
  assert.strictEqual(
    payment[1]?.configs.length,
    configs.filter((config) => config.provider !== 'steel').length
  );
}

async function testRequirePaymentCdnHardFilterIsIgnoredForLlmOnlyGate(): Promise<void> {
  // Payment-CDN hard filter removed: first fully-stable config in lane order wins,
  // even when requirePaymentCdn is set and paymentCdnOk is false.
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config, _signal) => fakeSession(config),
      probe: async (config, _session, _signal) => ({
        stablePasses: 2,
        attempts: 2,
        latencyMs: 1,
        paymentCdnOk: config.key === 'steel_managed',
      }),
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    },
    { requirePaymentCdn: true }
  );
  assert.strictEqual(winner.config.key, configs[0]?.key);
  assert.deepStrictEqual(promoted, [winner.config.key]);
}

async function testCfOnlyAvoidPicksFastestNonAvoided(): Promise<void> {
  // CF-only (no payment CDN hard filter): drop avoided exit; pick lowest latency.
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config, _signal) => fakeSession(config),
      probe: async (config, _session, _signal) => ({
        stablePasses: 2,
        attempts: 2,
        latencyMs: config.key === 'kernel_isp' ? 1 : config.key === 'steel_managed' ? 9000 : 100,
        paymentCdnOk: false,
        paymentCdnHosts: { 'js.stripe.com': false, 'api.stripe.com': false, 'stripe.js': false },
      }),
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    },
    { avoidConfigKey: 'kernel_isp' }
  );
  // Sequential lane: first non-avoided full clear (avoided tried last).
  assert.notStrictEqual(winner.config.key, 'kernel_isp');
  assert.deepStrictEqual(promoted, [winner.config.key]);
}

async function testAvoidConfigKeyBeatsPartialPaymentHostClear(): Promise<void> {
  // Eventim guest checkout (agent 48ef13f0, 2026-08-10): recover-challenge logged
  // avoidConfigKey=steel_managed then re-promoted steel_managed because js.stripe.com
  // alone outranked the avoid penalty. With hard filters (no soft host ranking),
  // CF-only + avoid must pick the fastest non-avoided CF-stable config.
  const configs = browserRecoveryCandidates({
    country: 'US',
    state: 'CA',
    city: 'SAN FRANCISCO',
  });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config, _signal) => fakeSession(config),
      probe: async (config, _session, _signal) => ({
        stablePasses: 2,
        attempts: 2,
        latencyMs:
          config.key === 'steel_managed' ? 26850 : config.key === 'kernel_isp' ? 5855 : 8000,
        paymentCdnOk: false,
        paymentCdnHosts:
          config.key === 'steel_managed'
            ? { 'js.stripe.com': true, 'api.stripe.com': false, 'stripe.js': false }
            : { 'js.stripe.com': false, 'api.stripe.com': false, 'stripe.js': false },
      }),
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    },
    { avoidConfigKey: 'steel_managed' }
  );
  assert.notStrictEqual(winner.config.key, 'steel_managed');
  assert.deepStrictEqual(promoted, [winner.config.key]);
  // Sequential lane order: first non-avoided full clear wins (not lowest latency).
  assert.strictEqual(winner.config.key, 'steel_fixed');
}

async function testHardPaymentCdnFilterKeepsOnlyWorkingConfig(): Promise<void> {
  // After CDN hard-filter removal, only fully-stable LLM clears are eligible.
  // Simulate Eventim: every Kernel exit stays challenged; only steel_managed clears.
  // avoidConfigKey=steel_managed still allows promote when it is the sole survivor.
  const configs = browserRecoveryCandidates({
    country: 'US',
    state: 'TX',
    city: 'DALLAS',
  });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config, _signal) => fakeSession(config),
      probe: async (config, _session, _signal) => {
        if (config.key === 'steel_managed') {
          return {
            stablePasses: 2,
            attempts: 2,
            latencyMs: 12380,
            paymentCdnOk: true,
          };
        }
        return {
          stablePasses: 0,
          attempts: 2,
          latencyMs: 6518,
          paymentCdnOk: false,
        };
      },
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    },
    { avoidConfigKey: 'steel_managed', requirePaymentCdn: true }
  );
  assert.strictEqual(winner.config.key, 'steel_managed');
  assert.deepStrictEqual(promoted, ['steel_managed']);
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
    url: () => 'https://order.online/store/blue-bottle',
    waitForTimeout: async () => undefined,
    evaluate: async (
      pageFunction: unknown,
      arg?: { url: string; hostKey: string; loadAsScript: boolean }
    ) => {
      if (arg?.url) {
        const hosts: Record<string, boolean> = { [arg.hostKey]: true };
        if (arg.loadAsScript) hosts['script.load'] = true;
        return hosts;
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
        await (pageFunction as () => Promise<void>)();
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

  const result = await probeCandidateBrowser(
    session,
    'https://order.online/store/blue-bottle',
    {
      cookies,
      origins: [
        {
          origin: 'https://order.online',
          localStorage: [{ name: 'signedInCart', value: 'keep' }],
          indexedDB: [],
        },
      ],
    },
    {
      blockedResourceUrl: 'https://js.cdn.example/v3',
      waitForSolver: async () => ({
        clean: true,
        reason: null,
        title: 'Blue Bottle Coffee',
        usage: null,
      }),
    }
  );

  assert.deepStrictEqual(addedCookies, cookies, 'full auth cookies must be loaded before probing');
  assert.strictEqual(newContextCalls, 0, 'the disposable incognito context is not promoted');
  assert.strictEqual(disposablePageVisits, 0);
  assert.strictEqual(defaultPageVisits, 1, 'the exact promoted context must pass once');
  assert.strictEqual(initScripts.length, 1, 'origin state is installed on the promoted context');
  assert.strictEqual(originStorageRestores, 1, 'origin auth is awaited before the clean probe');
  assert.strictEqual(defaultContextCloseCalls, 0, 'the promoted context must remain alive');
  assert.strictEqual(browserCloseCalls, 1, 'only the validation CDP connection is closed');
  assert.strictEqual(result.stablePasses, 1);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.paymentCdnOk, true);
  assert.deepStrictEqual(result.paymentCdnHosts, {});
  assert.deepStrictEqual(result.classifierLlmUsage, []);
  assert.strictEqual(result.settledUrl, 'https://order.online/store/blue-bottle');
  assert.strictEqual(result.classifierChallenged, false);
}

function testPaymentCdnProbeUsesNoCorsForHostFetches(): void {
  // api.stripe.com does not send ACAO for Eventim; default-cors fetch throws
  // even when the proxy tunnel works (false-negative api=false on steel_managed).
  const source = readFileSync(
    new URL('../../providers/browser/paymentCdnProbe.ts', import.meta.url),
    'utf8'
  );
  assert.match(source, /mode:\s*['"]no-cors['"]/);
  assert.match(source, /createElement\('script'\)/);
}

async function main(): Promise<void> {
  testTransportFailureTriesAlternateProviderBeforeSameProviderTiers();
  await testUnfinishedNetworkBodyDoesNotBlockRecoveryProbe();
  await testTransportCandidateDeadlineReachesNextProvider();
  await testTransportSearchDeadlineCancelsAllLanesBeforeHttpTimeout();
  await testFailedPromotionHonorsExpiredSearchDeadline();
  testPaymentCdnFocusedSearchPlanSkipsAvoidAndKernelsFirst();
  await testRequirePaymentCdnHardFilterIsIgnoredForLlmOnlyGate();
  await testCfOnlyAvoidPicksFastestNonAvoided();
  await testAvoidConfigKeyBeatsPartialPaymentHostClear();
  await testHardPaymentCdnFilterKeepsOnlyWorkingConfig();
  await testCandidateProbeUsesThePromotedDefaultContext();
  testPaymentCdnProbeUsesNoCorsForHostFetches();
  process.stdout.write('PASS staged browser challenge recovery payment gates\n');
}

void main();
