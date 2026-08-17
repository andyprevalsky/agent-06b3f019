#!/usr/bin/env tsx
/**
 * Payment-CDN probe/promotion gates (part 2) — split for max-lines.
 */
import assert from 'node:assert';
import type { Browser } from 'playwright';
import {
  blockedResourceRequiresPaymentCdn,
  browserRecoveryCandidates,
  probeCandidateBrowser,
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
    {},
    { requirePaymentCdn: true }
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
    {},
    { requirePaymentCdn: true }
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
      gotoCount === 1 ? '<h1>Just a moment...</h1>' : '<main>Billing Address</main>',
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
    {},
    { requirePaymentCdn: true }
  );
  assert.strictEqual(gotoCount, 2, 'must retry after first CF challenge');
  assert.strictEqual(result.stablePasses, 1, 'second clean load counts');
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(result.paymentCdnOk, true);
}

async function testCfOnlyProbeSkipsPaymentCdn(): Promise<void> {
  // Non-payment recoveries must not re-nav or run Stripe.js probing.
  let evaluateCalls = 0;
  let gotoCount = 0;
  const fakePage = {
    goto: async () => {
      gotoCount += 1;
      return { status: () => 200 };
    },
    waitForTimeout: async () => undefined,
    evaluate: async (pageFunction: () => Promise<unknown>) => {
      evaluateCalls += 1;
      const source = Function.prototype.toString.call(pageFunction);
      if (source.includes('js.stripe.com')) {
        throw new Error('payment CDN probe must not run for CF-only recovery');
      }
      return undefined;
    },
    title: async () => 'Event Listing',
    locator: () => ({ innerText: async () => 'Tickets' }),
    content: async () => '<main>Tickets</main>',
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
    ...fakeSession({ key: 'kernel_residential_city', provider: 'kernel', proxyMode: 'residential' }),
    validationBrowser: browser,
  };
  const result = await probeCandidateBrowser(
    session,
    'https://wl.eventim.us/event/lyny/692405',
    {}
  );
  assert.strictEqual(gotoCount, 2, 'CF probe still runs two attempts');
  assert.strictEqual(result.stablePasses, 2);
  assert.strictEqual(result.paymentCdnOk, false);
  assert.deepStrictEqual(result.paymentCdnHosts, {});
  assert.strictEqual(evaluateCalls, 0, 'Stripe evaluate must not run without requirePaymentCdn');
}

function testBlockedResourceRequiresPaymentCdn(): void {
  assert.strictEqual(blockedResourceRequiresPaymentCdn('https://js.stripe.com/v3'), true);
  assert.strictEqual(blockedResourceRequiresPaymentCdn('https://m.stripe.com/6'), true);
  assert.strictEqual(
    blockedResourceRequiresPaymentCdn('https://wl.eventim.us/cdn-cgi/challenge'),
    false
  );
  assert.strictEqual(blockedResourceRequiresPaymentCdn(undefined), false);
}

async function main(): Promise<void> {
  await testPaymentCdnOkRequiresStripeJsScriptLoad();
  await testPaymentCdnOkWhenStripeJsLoadsWithoutApi();
  await testRequirePaymentCdnRejectsCfOnlyWinners();
  await testRequirePaymentCdnPromotesStripeJsWinner();
  await testProbeRetriesAfterFirstCfChallenge();
  await testCfOnlyProbeSkipsPaymentCdn();
  testBlockedResourceRequiresPaymentCdn();
  process.stdout.write('PASS staged browser challenge recovery payment gates part2\n');
}

void main();
