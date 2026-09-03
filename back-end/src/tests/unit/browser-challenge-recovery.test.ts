#!/usr/bin/env tsx
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import {
  browserRecoveryCandidates,
  challengeDetectionReason,
  isUsableDocumentTitle,
  pageLooksChallenged,
  recoveryConfigKeyForSession,
  runLaneConfigSearch,
  orderConfigsForLane,
  shouldPreferSteelForChallengeTarget,
  type BrowserRecoveryConfig,
  type RecoveryCandidateSession,
} from '../../providers/browser/challengeRecovery';
import { kernelCaptchaTelemetryConfig } from '../../providers/browser/captchaTelemetry';
import { buildSteelRecoveryBrowserOptions } from '../../providers/steel/sessionRecovery';

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
      'steel_fixed',
      'kernel_mobile',
      'kernel_residential_city',
      'kernel_residential_state',
      'steel_managed',
      'kernel_isp',
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

async function testLaneSearchTriesConfigsSequentiallyAndPromotesFirstFullClear(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US', state: 'CA', city: 'SAN FRANCISCO' });
  const created: string[] = [];
  const probed: string[] = [];
  const released: string[] = [];
  const promoted: string[] = [];
  let activeCreates = 0;
  let maxActiveCreates = 0;

  const winner = await runLaneConfigSearch(configs, [{ key: 'auth_kept', storageState: {} }], {
    create: async (config, _signal) => {
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      await new Promise((resolve) => setTimeout(resolve, 5));
      created.push(config.key);
      activeCreates -= 1;
      return fakeSession(config);
    },
    probe: async (config, _session, lane, _signal) => {
      assert.strictEqual(lane.key, 'auth_kept');
      probed.push(config.key);
      // First config fails; second fully clears — sequential, no partial promote.
      if (probed.length === 1) {
        return { stablePasses: 0, attempts: 2, latencyMs: 1, paymentCdnOk: true };
      }
      return { stablePasses: 2, attempts: 2, latencyMs: 1, paymentCdnOk: true };
    },
    promote: async (candidate) => {
      promoted.push(candidate.config.key);
    },
    release: async (config) => {
      released.push(config.key);
    },
  });

  assert.strictEqual(maxActiveCreates, 1, 'configs within a lane must be sequential');
  assert.strictEqual(probed.length, 2);
  assert.strictEqual(winner.config.key, probed[1]);
  assert.deepStrictEqual(promoted, [winner.config.key]);
  assert.ok(released.includes(probed[0]!));
}

async function testParallelCookieLanesFirstFullClearWins(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' }).slice(0, 2);
  const promoted: string[] = [];
  const probedLanes: string[] = [];
  const winner = await runLaneConfigSearch(
    configs,
    [
      { key: 'auth_kept', storageState: { cookies: [{ name: 'a' }] } },
      { key: 'stripped', storageState: { cookies: [] } },
    ],
    {
      create: async (config, _signal) => fakeSession(config),
      probe: async (config, _session, lane, _signal) => {
        probedLanes.push(`${lane.key}:${config.key}`);
        await new Promise((resolve) => setTimeout(resolve, lane.key === 'stripped' ? 1 : 30));
        if (lane.key === 'stripped') {
          return { stablePasses: 2, attempts: 2, latencyMs: 1, paymentCdnOk: true };
        }
        return { stablePasses: 0, attempts: 2, latencyMs: 50, paymentCdnOk: true };
      },
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    }
  );
  assert.ok(probedLanes.some((entry) => entry.startsWith('stripped:')));
  assert.deepStrictEqual(promoted, [winner.config.key]);
}

async function testLaneSearchReturnsBeforeSlowSiblingFinishes(): Promise<void> {
  /** Hotels.com: sibling auth_kept probe held recover-challenge HTTP open after
   * promote released the live CDP — agent reconnect had no ws_url yet. */
  const configs = browserRecoveryCandidates({ country: 'US' }).slice(0, 1);
  let slowSiblingFinished = false;
  const started = Date.now();
  const winner = await runLaneConfigSearch(
    configs,
    [
      { key: 'auth_kept', storageState: {} },
      { key: 'stripped', storageState: {} },
    ],
    {
      create: async (config, _signal) => fakeSession(config),
      probe: async (_config, _session, lane, _signal) => {
        if (lane.key === 'stripped') {
          return { stablePasses: 2, attempts: 2, latencyMs: 1, paymentCdnOk: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        slowSiblingFinished = true;
        return { stablePasses: 0, attempts: 2, latencyMs: 400, paymentCdnOk: true };
      },
      promote: async () => undefined,
      release: async () => undefined,
    }
  );
  const elapsed = Date.now() - started;
  assert.strictEqual(winner.config.key, configs[0]!.key);
  assert.ok(elapsed < 250, `must return right after promote, not wait for sibling (${elapsed}ms)`);
  assert.equal(slowSiblingFinished, false, 'sibling probe must still be in flight when we return');
}

async function testNoStableCandidateCleansEverything(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' });
  const released: string[] = [];
  await assert.rejects(
    runLaneConfigSearch(configs, [{ key: 'default', storageState: {} }], {
      create: async (config, _signal) => fakeSession(config),
      probe: async (_config, _session, _lane, _signal) => ({
        stablePasses: 0,
        attempts: 2,
        latencyMs: 1,
        paymentCdnOk: true,
      }),
      promote: async () => assert.fail('zero-pass candidate must never be promoted'),
      release: async (config) => {
        released.push(config.key);
      },
    }),
    /No stable browser configuration/
  );
  assert.strictEqual(released.length, configs.length);
}

async function testPartialStableCandidateIsNeverPromoted(): Promise<void> {
  const configs = browserRecoveryCandidates({ country: 'US' });
  const promoted: string[] = [];
  await assert.rejects(
    runLaneConfigSearch(configs, [{ key: 'default', storageState: {} }], {
      create: async (config, _signal) => fakeSession(config),
      probe: async (config, _session, _lane, _signal) => ({
        stablePasses: config.key === 'kernel_mobile' ? 1 : 0,
        attempts: 2,
        latencyMs: 1,
        paymentCdnOk: true,
      }),
      promote: async (candidate) => {
        promoted.push(candidate.config.key);
      },
      release: async () => undefined,
    }),
    /No stable browser configuration/
  );
  assert.deepStrictEqual(promoted, []);
}

async function testLateCreateAfterAbortIsReleased(): Promise<void> {
  /** When a sibling lane wins, in-flight create must still be released if it
   * resolves after abort — otherwise CDP sessions leak. */
  const configs = browserRecoveryCandidates({ country: 'US' }).slice(0, 1);
  const releasedSessionIds: string[] = [];
  let slowCreateStarted = false;
  let releaseSlowCreate: (() => void) | undefined;
  const slowCreateGate = new Promise<void>((resolve) => {
    releaseSlowCreate = resolve;
  });

  const winner = await runLaneConfigSearch(
    configs,
    [
      { key: 'auth_kept', storageState: {} },
      { key: 'stripped', storageState: {} },
    ],
    {
      create: async (config, _signal) => {
        if (!slowCreateStarted) {
          slowCreateStarted = true;
          await slowCreateGate;
          return {
            ...fakeSession(config),
            sessionId: `session-${config.key}-late`,
          };
        }
        return fakeSession(config);
      },
      probe: async (_config, _session, lane, _signal) => {
        if (lane.key === 'stripped') {
          return { stablePasses: 2, attempts: 2, latencyMs: 1, paymentCdnOk: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { stablePasses: 0, attempts: 2, latencyMs: 1, paymentCdnOk: true };
      },
      promote: async () => undefined,
      release: async (_config, session) => {
        releasedSessionIds.push(session.sessionId);
      },
    }
  );

  assert.strictEqual(winner.config.key, configs[0]!.key);
  releaseSlowCreate!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    releasedSessionIds.includes(`session-${configs[0]!.key}-late`),
    `late create after abort must be released (got ${JSON.stringify(releasedSessionIds)})`
  );
}

async function testAbortedProbeDoesNotDoubleRelease(): Promise<void> {
  /** Sibling win clears activeSessions via abort listener; the losing probe's
   * catch must not release the same remote session a second time. */
  const configs = browserRecoveryCandidates({ country: 'US' }).slice(0, 1);
  const releaseCounts = new Map<string, number>();
  let releaseSlowProbe: (() => void) | undefined;
  const slowProbeGate = new Promise<void>((resolve) => {
    releaseSlowProbe = resolve;
  });

  const winner = await runLaneConfigSearch(
    configs,
    [
      { key: 'auth_kept', storageState: {} },
      { key: 'stripped', storageState: {} },
    ],
    {
      create: async (config, _signal) => ({
        ...fakeSession(config),
        sessionId: `session-${config.key}`,
      }),
      probe: async (_config, _session, lane, _signal) => {
        if (lane.key === 'stripped') {
          return { stablePasses: 2, attempts: 2, latencyMs: 1, paymentCdnOk: true };
        }
        await slowProbeGate;
        return { stablePasses: 0, attempts: 2, latencyMs: 1, paymentCdnOk: true };
      },
      promote: async () => undefined,
      release: async (_config, session) => {
        releaseCounts.set(session.sessionId, (releaseCounts.get(session.sessionId) ?? 0) + 1);
      },
    }
  );

  assert.strictEqual(winner.config.key, configs[0]!.key);
  releaseSlowProbe!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const authKeptReleases = releaseCounts.get(`session-${configs[0]!.key}`) ?? 0;
  assert.strictEqual(
    authKeptReleases,
    1,
    `aborted probe must release auth_kept session once (got ${authKeptReleases})`
  );
}

async function testProbeCandidateBrowserSettlesOnAbort(): Promise<void> {
  /** Default probe must observe AbortSignal and settle promptly mid-solver. */
  const { probeCandidateBrowser } = await import('../../providers/browser/challengeRecovery');
  const abort = new AbortController();
  let solveStarted = false;
  let releaseSolve: (() => void) | undefined;
  const solveGate = new Promise<void>((resolve) => {
    releaseSolve = resolve;
  });
  const closed: string[] = [];
  const session: RecoveryCandidateSession = {
    ...fakeSession(browserRecoveryCandidates({ country: 'US' })[0]!),
    validationBrowser: {
      contexts: () => [
        {
          addCookies: async () => undefined,
          addInitScript: async () => undefined,
          pages: () => [
            {
              goto: async () => null,
              url: () => 'https://example.com/',
              evaluate: async () => undefined,
            },
          ],
          newPage: async () => {
            throw new Error('newPage should not be needed');
          },
        },
      ],
      close: async () => {
        closed.push('closed');
      },
    } as unknown as Browser,
  };

  let solverEntered!: () => void;
  const solverStarted = new Promise<void>((resolve) => {
    solverEntered = resolve;
  });
  const probePromise = probeCandidateBrowser(
    session,
    'https://example.com/',
    {},
    {
      waitForSolver: async () => {
        solveStarted = true;
        solverEntered();
        await solveGate;
        return {
          clean: true,
          reason: 'ok',
          title: 'Example',
          usage: null,
        };
      },
    },
    {},
    abort.signal
  );

  await solverStarted;
  assert.ok(solveStarted, 'solver must start before abort');
  const started = Date.now();
  abort.abort();
  await assert.rejects(probePromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.strictEqual(error.message, 'lane_aborted');
    return true;
  });
  assert.ok(Date.now() - started < 500, 'aborted probe must settle promptly');
  assert.deepStrictEqual(closed, ['closed']);
  releaseSolve?.();
}

function testOrderConfigsForLane(): void {
  const configs = browserRecoveryCandidates({ country: 'US', state: 'CA', city: 'SAN FRANCISCO' });
  const ordered = orderConfigsForLane(configs, 'kernel_residential_city');
  assert.strictEqual(ordered[ordered.length - 1]?.key, 'kernel_residential_city');
  assert.ok(ordered[0]?.key !== 'kernel_residential_city');
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
    ['steel_fixed', 'steel_managed']
  );
  assert.ok(preferred.every((candidate) => candidate.provider === 'steel'));
}

async function main(): Promise<void> {
  testCandidateMatrix();
  testConfigSearchUsesHiddenRemoteSessionsOnly();
  await testLaneSearchTriesConfigsSequentiallyAndPromotesFirstFullClear();
  await testParallelCookieLanesFirstFullClearWins();
  await testLaneSearchReturnsBeforeSlowSiblingFinishes();
  await testNoStableCandidateCleansEverything();
  await testPartialStableCandidateIsNeverPromoted();
  await testLateCreateAfterAbortIsReleased();
  await testAbortedProbeDoesNotDoubleRelease();
  await testProbeCandidateBrowserSettlesOnAbort();
  // Payment-CDN / Stripe.js ranking + hard gates live in
  // browser-challenge-recovery-payment.test.ts (max-lines split).
  // Steel recovery city-drop retry: browser-challenge-recovery-steel.test.ts.
  // Learned preferred-config seeding + schemas: .part2.test.ts.
  testOrderConfigsForLane();
  testRecoveryConfigKeyForSession();
  testChallengeDetection();
  testSteelPreferredWhenCdnHardFilterActive();
  process.stdout.write('PASS staged browser challenge recovery\n');
}

void main();
