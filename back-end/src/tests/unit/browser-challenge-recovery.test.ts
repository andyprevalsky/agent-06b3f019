#!/usr/bin/env tsx
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import {
  availableBrowserRecoveryCandidates,
  browserRecoveryCandidates,
  recoveryConfigKeyForSession,
  runLaneConfigSearch,
  orderConfigsForLane,
  type BrowserRecoveryConfig,
  type RecoveryCandidateSession,
} from '../../providers/browser/challengeRecovery';
import { kernelCaptchaTelemetryConfig } from '../../providers/browser/captchaTelemetry';
import { buildSteelRecoveryBrowserOptions } from '../../providers/steel/sessionRecovery';
import { testChallengeDetection } from './browser-challenge-recovery-detection.cases';

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
      'browser_use_residential_country',
      'kernel_isp',
      // Tilion exits come after the existing catalog so Kernel/Steel order is unchanged.
      'tilion_residential',
      'tilion_mobile',
    ]
  );
  const previousKey = process.env.BROWSER_USE_API_KEY;
  const previousFlag = process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
  try {
    process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'true';
    delete process.env.BROWSER_USE_API_KEY;
    assert.ok(
      availableBrowserRecoveryCandidates({ country: 'US' }).every(
        (candidate) => candidate.provider !== 'browser-use'
      ),
      'unconfigured Browser Use must not consume challenge recovery budget'
    );
    process.env.BROWSER_USE_API_KEY = 'test-key';
    assert.ok(
      availableBrowserRecoveryCandidates({ country: 'US' }).some(
        (candidate) => candidate.provider === 'browser-use'
      ),
      'configured Browser Use must join challenge recovery'
    );
    process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'false';
    assert.ok(
      availableBrowserRecoveryCandidates({ country: 'US' }).every(
        (candidate) => candidate.provider !== 'browser-use'
      ),
      'disabled Browser Use must not consume challenge recovery budget'
    );
  } finally {
    if (previousKey === undefined) delete process.env.BROWSER_USE_API_KEY;
    else process.env.BROWSER_USE_API_KEY = previousKey;
    if (previousFlag === undefined) delete process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
    else process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = previousFlag;
  }
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
  const facade = readFileSync(
    new URL('../../providers/browser/challengeRecovery.ts', import.meta.url),
    'utf8'
  );
  assert.match(
    facade,
    /export \{ searchAndPromoteBrowserConfig \} from '\.\/challengeRecoveryPromote'/,
    'challengeRecovery.ts must re-export the promote composition root'
  );
  const source = readFileSync(
    new URL('../../providers/browser/challengeRecoveryPromote.ts', import.meta.url),
    'utf8'
  );
  const searchStart = source.indexOf('export async function searchAndPromoteBrowserConfig');
  assert.ok(searchStart >= 0, 'config-search composition root must exist');
  const searchSource = source.slice(searchStart);
  assert.match(searchSource, /dependencies\.createKernel/);
  assert.match(searchSource, /dependencies\.createSteel/);
  assert.match(searchSource, /dependencies\.createBrowserUse/);
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
  assert.strictEqual(
    recoveryConfigKeyForSession('browser-use', null),
    'browser_use_residential_country'
  );
  assert.strictEqual(recoveryConfigKeyForSession('kernel', 'mobile_city'), 'kernel_mobile');
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
  testOrderConfigsForLane();
  testRecoveryConfigKeyForSession();
  testChallengeDetection();
  process.stdout.write('PASS staged browser challenge recovery\n');
}

void main();
