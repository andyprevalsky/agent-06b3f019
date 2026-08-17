#!/usr/bin/env tsx
/**
 * Payment-CDN / Stripe.js ranking + probe gates for challenge recovery.
 * Companion to browser-challenge-recovery.test.ts (keeps each file under max-lines).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import {
  blockedResourceRequiresPaymentCdn,
  browserRecoveryCandidates,
  paymentCdnFocusedCandidates,
  probeCandidateBrowser,
  recoverySearchPlan,
  runParallelBrowserConfigSearch,
  targetLooksLikePaymentDocument,
  type BrowserRecoveryConfig,
  type RecoveryCandidateSession,
} from '../../providers/browser/challengeRecovery';

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
  assert.strictEqual(payment[1]?.configs.length, configs.length);
}

async function testRequirePaymentCdnHardFilterPicksStripeCapable(): Promise<void> {
  // Hard filter: only paymentCdnOk configs are eligible. Soft latency ranking
  // among CF-clears must not promote Kernel when Stripe.js is required.
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config) => fakeSession(config),
      probe: async (config) => ({
        stablePasses: 2,
        attempts: 2,
        latencyMs: config.key === 'steel_managed' ? 500 : 1,
        paymentCdnOk: config.key === 'steel_managed',
      }),
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    },
    { requirePaymentCdn: true }
  );
  assert.strictEqual(winner.config.key, 'steel_managed');
  assert.deepStrictEqual(promoted, ['steel_managed']);
}

async function testCfOnlyAvoidPicksFastestNonAvoided(): Promise<void> {
  // CF-only (no payment CDN hard filter): drop avoided exit; pick lowest latency.
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config) => fakeSession(config),
      probe: async (config) => ({
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
  // Fastest non-avoided CF-stable (not steel soft-bias).
  assert.notStrictEqual(winner.config.key, 'kernel_isp');
  assert.ok(winner.probe.latencyMs <= 100);
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
      create: async (config) => fakeSession(config),
      probe: async (config) => ({
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
  assert.strictEqual(winner.config.key, 'kernel_isp');
}

async function testHardPaymentCdnFilterKeepsOnlyWorkingConfig(): Promise<void> {
  // Eventim flake (agent f1ba73c2, 2026-08-16): recovery must hard-filter to
  // configs that clear Stripe.js when that is the failure mode — not soft-rank
  // paymentCdnOk vs avoidConfigKey. Exact probe matrix from backend.log @ 22:58:59Z.
  // With requirePaymentCdn=true, steel_managed is the only survivor; avoid is
  // irrelevant because no alternative works.
  const configs = browserRecoveryCandidates({
    country: 'US',
    state: 'TX',
    city: 'DALLAS',
  });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config) => fakeSession(config),
      probe: async (config) => {
        if (config.key === 'steel_managed') {
          return {
            stablePasses: 2,
            attempts: 2,
            latencyMs: 12380,
            paymentCdnOk: true,
            paymentCdnHosts: {
              'js.stripe.com': true,
              'api.stripe.com': false,
              'm.stripe.com': true,
              'stripe.js': true,
            },
          };
        }
        if (config.key === 'kernel_isp') {
          return {
            stablePasses: 2,
            attempts: 2,
            latencyMs: 6518,
            paymentCdnOk: false,
            paymentCdnHosts: {
              'js.stripe.com': true,
              'api.stripe.com': true,
              'm.stripe.com': true,
              'stripe.js': false,
            },
          };
        }
        return {
          stablePasses: 2,
          attempts: 2,
          latencyMs: 13122,
          paymentCdnOk: false,
          paymentCdnHosts: {
            'js.stripe.com': true,
            'api.stripe.com': true,
            'm.stripe.com': true,
            'stripe.js': false,
          },
        };
      },
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    },
    { avoidConfigKey: 'steel_managed', requirePaymentCdn: true }
  );
  assert.strictEqual(
    winner.config.key,
    'steel_managed',
    'hard paymentCdn filter: only working config survives (ignore avoid)'
  );
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
    waitForTimeout: async () => undefined,
    evaluate: async (pageFunction: () => Promise<unknown>) => {
      const source = Function.prototype.toString.call(pageFunction);
      if (source.includes('js.stripe.com') && source.includes('createElement')) {
        return {
          'js.stripe.com': true,
          'api.stripe.com': true,
          'm.stripe.com': true,
          'stripe.js': true,
        };
      }
      if (source.includes('js.stripe.com') || source.includes('api.stripe.com')) {
        return {
          'js.stripe.com': false,
          'api.stripe.com': false,
          'm.stripe.com': false,
          'stripe.js': false,
        };
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
    paymentCdnHosts: {
      'js.stripe.com': true,
      'api.stripe.com': true,
      'm.stripe.com': true,
      'stripe.js': true,
    },
  });
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

async function testPaymentCdnOkRequiresStripeJsScriptLoad(): Promise<void> {
  // Eventim (5d59430b / 7f91554e): fetch(js.stripe.com) can succeed while
  // <script src=js.stripe.com/v3> fails (ORB / "Failed to load Stripe.js").
  // paymentCdnOk must stay false until the script-load probe clears.
  const fakePage = {
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => undefined,
    evaluate: async (pageFunction: () => Promise<unknown>) => {
      const source = Function.prototype.toString.call(pageFunction);
      if (source.includes('js.stripe.com') && source.includes('createElement')) {
        return {
          'js.stripe.com': true,
          'api.stripe.com': true,
          'm.stripe.com': true,
          'stripe.js': false,
        };
      }
      return undefined;
    },
    title: async () => 'Guest Checkout',
    locator: () => ({ innerText: async () => 'Billing Address' }),
    content: async () => '<main>Billing Address</main>',
  };
  const browser = {
    contexts: () => [
      {
        pages: () => [fakePage],
        newPage: async () => fakePage,
        addCookies: async () => undefined,
        addInitScript: async () => undefined,
        close: async () => undefined,
      },
    ],
    newContext: async () => {
      throw new Error('unexpected newContext');
    },
    close: async () => undefined,
  } as unknown as Browser;
  const session = {
    ...fakeSession({ key: 'steel_managed', provider: 'steel', proxyMode: 'managed' }),
    validationBrowser: browser,
  };
  const result = await probeCandidateBrowser(
    session,
    'https://checkout.eventim.us/?afflky=1015Folsom',
    {}
  );
  assert.strictEqual(result.paymentCdnOk, false);
  assert.deepStrictEqual(result.paymentCdnHosts, {
    'js.stripe.com': true,
    'api.stripe.com': true,
    'm.stripe.com': true,
    'stripe.js': false,
  });
}

async function testPaymentCdnOkWhenStripeJsLoadsWithoutApi(): Promise<void> {
  // Live steel_managed @ Dallas: Stripe.js + js/m.stripe.com OK, api.stripe.com
  // Failed to fetch even with no-cors. Checkout recovery must still accept this.
  const fakePage = {
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => undefined,
    evaluate: async (pageFunction: () => Promise<unknown>) => {
      const source = Function.prototype.toString.call(pageFunction);
      if (source.includes('js.stripe.com') && source.includes('createElement')) {
        return {
          'js.stripe.com': true,
          'api.stripe.com': false,
          'm.stripe.com': true,
          'stripe.js': true,
        };
      }
      return undefined;
    },
    title: async () => 'Eventim Checkout',
    locator: () => ({ innerText: async () => 'Billing Address' }),
    content: async () => '<main>Billing Address</main>',
  };
  const browser = {
    contexts: () => [
      {
        pages: () => [fakePage],
        newPage: async () => fakePage,
        addCookies: async () => undefined,
        addInitScript: async () => undefined,
        close: async () => undefined,
      },
    ],
    newContext: async () => {
      throw new Error('unexpected newContext');
    },
    close: async () => undefined,
  } as unknown as Browser;
  const session = {
    ...fakeSession({ key: 'steel_managed', provider: 'steel', proxyMode: 'managed' }),
    validationBrowser: browser,
  };
  const result = await probeCandidateBrowser(
    session,
    'https://checkout.eventim.us/?afflky=1015Folsom',
    {}
  );
  assert.strictEqual(result.paymentCdnOk, true);
  assert.strictEqual(result.paymentCdnHosts?.['api.stripe.com'], false);
  assert.strictEqual(result.paymentCdnHosts?.['stripe.js'], true);
}

async function testRequirePaymentCdnRejectsCfOnlyWinners(): Promise<void> {
  // Checkout recovery must not promote a CF-stable winner that failed Stripe.js.
  assert.ok(targetLooksLikePaymentDocument('https://checkout.eventim.us/?afflky=1015Folsom'));
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  await assert.rejects(
    () =>
      runParallelBrowserConfigSearch(
        configs,
        {
          create: async (config) => fakeSession(config),
          probe: async () => ({
            stablePasses: 2,
            attempts: 2,
            latencyMs: 10,
            paymentCdnOk: false,
            paymentCdnHosts: {
              'js.stripe.com': true,
              'api.stripe.com': true,
              'stripe.js': false,
            },
          }),
          promote: async (candidate) => {
            promoted.push(candidate.config.key);
          },
          release: async () => undefined,
        },
        { requirePaymentCdn: true }
      ),
    /Stripe\.js loaded/
  );
  assert.deepStrictEqual(promoted, []);
}

async function testRequirePaymentCdnPromotesStripeJsWinner(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
      create: async (config) => fakeSession(config),
      probe: async (config) => ({
        stablePasses: 2,
        attempts: 2,
        latencyMs: config.key === 'steel_managed' ? 9000 : 10,
        paymentCdnOk: config.key === 'steel_managed',
        paymentCdnHosts:
          config.key === 'steel_managed'
            ? { 'js.stripe.com': true, 'api.stripe.com': true, 'stripe.js': true }
            : { 'js.stripe.com': true, 'api.stripe.com': true, 'stripe.js': false },
      }),
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    },
    { requirePaymentCdn: true }
  );
  assert.strictEqual(winner.config.key, 'steel_managed');
  assert.deepStrictEqual(promoted, ['steel_managed']);
}

async function testProbeRetriesAfterFirstCfChallenge(): Promise<void> {
  // Eventim k=4: steel_managed attempt-1 "Just a moment..." used to break the
  // probe loop, leaving stablePasses=0 and discarding the only Stripe-capable
  // config. Second load often clears — continue, don't abort.
  let gotoCount = 0;
  const fakePage = {
    goto: async () => {
      gotoCount += 1;
      return { status: () => 200 };
    },
    waitForTimeout: async () => undefined,
    evaluate: async (pageFunction: () => Promise<unknown>) => {
      const source = Function.prototype.toString.call(pageFunction);
      if (source.includes('js.stripe.com') && source.includes('createElement')) {
        return {
          'js.stripe.com': true,
          'api.stripe.com': false,
          'm.stripe.com': true,
          'stripe.js': true,
        };
      }
      return undefined;
    },
    title: async () => (gotoCount === 1 ? 'Just a moment...' : 'Eventim Checkout'),
    locator: () => ({
      innerText: async () => (gotoCount === 1 ? 'Checking your browser' : 'Billing Address'),
    }),
    content: async () =>
      gotoCount === 1
        ? '<h1>Just a moment...</h1>'
        : '<main>Billing Address</main>',
  };
  const browser = {
    contexts: () => [
      {
        pages: () => [fakePage],
        newPage: async () => fakePage,
        addCookies: async () => undefined,
        addInitScript: async () => undefined,
        close: async () => undefined,
      },
    ],
    newContext: async () => {
      throw new Error('unexpected newContext');
    },
    close: async () => undefined,
  } as unknown as Browser;
  const session = {
    ...fakeSession({ key: 'steel_managed', provider: 'steel', proxyMode: 'managed' }),
    validationBrowser: browser,
  };
  const result = await probeCandidateBrowser(
    session,
    'https://checkout.eventim.us/?afflky=1015Folsom',
    {}
  );
  assert.strictEqual(gotoCount, 2, 'must retry after first CF challenge');
  assert.strictEqual(result.stablePasses, 1, 'second clean load counts');
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(result.paymentCdnOk, true);
}

function testBlockedResourceRequiresPaymentCdn(): void {
  assert.strictEqual(
    blockedResourceRequiresPaymentCdn('https://js.stripe.com/v3'),
    true
  );
  assert.strictEqual(
    blockedResourceRequiresPaymentCdn('https://m.stripe.com/6'),
    true
  );
  assert.strictEqual(
    blockedResourceRequiresPaymentCdn('https://wl.eventim.us/cdn-cgi/challenge'),
    false
  );
  assert.strictEqual(blockedResourceRequiresPaymentCdn(undefined), false);
}

async function main(): Promise<void> {
  testPaymentCdnFocusedSearchPlanSkipsAvoidAndKernelsFirst();
  await testRequirePaymentCdnHardFilterPicksStripeCapable();
  await testCfOnlyAvoidPicksFastestNonAvoided();
  await testAvoidConfigKeyBeatsPartialPaymentHostClear();
  await testHardPaymentCdnFilterKeepsOnlyWorkingConfig();
  await testCandidateProbeUsesThePromotedDefaultContext();
  testPaymentCdnProbeUsesNoCorsForHostFetches();
  await testPaymentCdnOkRequiresStripeJsScriptLoad();
  await testPaymentCdnOkWhenStripeJsLoadsWithoutApi();
  await testRequirePaymentCdnRejectsCfOnlyWinners();
  await testRequirePaymentCdnPromotesStripeJsWinner();
  await testProbeRetriesAfterFirstCfChallenge();
  testBlockedResourceRequiresPaymentCdn();
  process.stdout.write('PASS staged browser challenge recovery payment gates\n');
}

void main();
