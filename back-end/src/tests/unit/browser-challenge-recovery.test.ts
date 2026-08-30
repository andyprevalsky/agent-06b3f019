#!/usr/bin/env tsx
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  browserRecoveryCandidates,
  challengeDetectionReason,
  compatiblePreferredBrowserConfig,
  isUsableDocumentTitle,
  pageLooksChallenged,
  sameSiteNavigationUrl,
  shouldPreferSteelForChallengeTarget,
} from '../../providers/browser/challengeRecovery';
import {
  challengeClassifierCostCents,
  CHALLENGE_LLM_MODEL,
} from '../../providers/browser/challengeLlmClassifier';
import { kernelCaptchaTelemetryConfig } from '../../providers/browser/captchaTelemetry';
import { buildSteelRecoveryBrowserOptions } from '../../providers/steel/sessionRecovery';
import {
  probeCookieVariantSchema,
  recoverChallengeSchema,
} from '../../domains/browser-session/types';

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
  assert.ok(!shouldPreferSteelForChallengeTarget('https://checkout.example.com/c/pay/cs_live_x'));
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
  // Lane-search + learned-config: browser-challenge-recovery.part2.test.ts
  // Payment-CDN / Stripe.js ranking + hard gates live in
  // browser-challenge-recovery-payment.test.ts (max-lines split).
  // Steel recovery city-drop retry: browser-challenge-recovery-steel.test.ts.
  testSameSiteNavigationUrl();
  testChallengeDetection();
  testChallengeLlmClassifierCostRouting();
  testSteelPreferredWhenCdnHardFilterActive();
  testPreferredConfigCompatibility();
  testRecoveryRequestSchema();
  process.stdout.write('PASS staged browser challenge recovery\n');
}

void main();
