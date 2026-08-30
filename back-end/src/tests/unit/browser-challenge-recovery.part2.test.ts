#!/usr/bin/env tsx
/**
 * Lane-search + learned-config coverage (part 2) — split for max-lines.
 */
import assert from 'node:assert';
import {
  buildPreferredBrowserConfig,
  browserRecoveryCandidates,
  orderConfigsForLane,
  recoveryConfigKeyForSession,
  runLaneConfigSearch,
} from '../../providers/browser/challengeRecovery';
import { createSessionWithContextUsingDependencies } from '../../providers/browser';
import {
  fakeSession,
  providerSession,
  steelSession,
  type BrowserSessionCreationDependencies,
} from './browser-challenge-recovery.test-helpers';

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
      probe: async (_config, _session, lane) => {
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
      probe: async () => ({ stablePasses: 0, attempts: 2, latencyMs: 1, paymentCdnOk: true }),
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

async function main(): Promise<void> {
  await testLaneSearchTriesConfigsSequentiallyAndPromotesFirstFullClear();
  await testParallelCookieLanesFirstFullClearWins();
  await testLaneSearchReturnsBeforeSlowSiblingFinishes();
  await testNoStableCandidateCleansEverything();
  await testPartialStableCandidateIsNeverPromoted();
  testOrderConfigsForLane();
  testRecoveryConfigKeyForSession();
  await testLearnedConfigSeedsTheNextSession();
  await testLearnedSteelFixedConfigSeedsTheNextSession();
  await testIncompatibleLearnedConfigFallsBackWithoutLeakingGeo();
  await testUnavailableLearnedConfigFallsBackToDeploymentDefault();
  process.stdout.write('PASS staged browser challenge recovery part 2\n');
}

void main();
