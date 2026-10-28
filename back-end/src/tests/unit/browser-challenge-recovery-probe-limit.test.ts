#!/usr/bin/env tsx
/**
 * T85: challenge recovery opened up to 5 Tilion candidate sessions in parallel
 * (one per storage lane) against the shared 20-session account cap. Live
 * candidates per recovery are bounded for concurrency-capped providers (Tilion,
 * default 2, BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES); others are unchanged.
 */
import assert from 'node:assert';
import type { Browser } from 'playwright';
import {
  maxParallelRecoveryProbes,
  runLaneConfigSearch,
  TILION_MAX_PARALLEL_RECOVERY_PROBES_DEFAULT,
  withProviderProbeLimits,
  type ConfigSearchDependencies,
} from '../../providers/browser/challengeRecoveryLaneSearch';
import type { BrowserRecoveryConfig } from '../../providers/browser/challengeRecovery';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LANES = Array.from({ length: 5 }, (_, index) => ({ key: `lane-${index}`, storageState: {} }));

function configsFor(provider: 'tilion' | 'kernel'): BrowserRecoveryConfig[] {
  return provider === 'tilion'
    ? [
        {
          key: 'tilion_residential',
          provider: 'tilion',
          proxyMode: 'residential_country',
          tilionProxyType: 'residential',
        },
        {
          key: 'tilion_direct',
          provider: 'tilion',
          proxyMode: 'direct',
          tilionProxyType: 'direct',
        },
      ]
    : [
        {
          key: 'kernel_mobile',
          provider: 'kernel',
          proxyMode: 'mobile_country',
          kernelProxyType: 'mobile',
          kernelSpecificity: 'country',
        },
        {
          key: 'kernel_isp',
          provider: 'kernel',
          proxyMode: 'isp_country',
          kernelProxyType: 'isp',
          kernelSpecificity: 'country',
        },
      ];
}

/** Fake provider: counts live candidate sessions; only `winnerKey` on `winnerLane` probes clean. */
function countingDependencies(winnerLane: string, winnerKey: string) {
  let live = 0;
  let maxLive = 0;
  let created = 0;
  const ended: string[] = [];
  const dependencies: ConfigSearchDependencies = {
    create: async (config) => {
      await sleep(20);
      created += 1;
      live += 1;
      maxLive = Math.max(maxLive, live);
      return {
        provider: config.provider,
        sessionId: `${config.key}-${created}`,
        debugUrl: 'https://debug.invalid',
        wsUrl: 'wss://cdp.invalid',
        proxySource: config.proxyMode,
        proxyLocation: { country: 'US' },
        profileId: null,
        profileSource: 'test',
        validationBrowser: {} as Browser,
      };
    },
    probe: async (config, _session, lane) => {
      await sleep(60);
      const clean = lane.key === winnerLane && config.key === winnerKey;
      return { stablePasses: clean ? 1 : 0, attempts: 1, latencyMs: 60, paymentCdnOk: true };
    },
    promote: async (winner) => {
      live -= 1; // the promoted session becomes the task's own browser
      ended.push(`promoted:${winner.session.sessionId}`);
    },
    release: async (_config, session) => {
      live -= 1;
      ended.push(`released:${session.sessionId}`);
    },
  };
  return { dependencies, stats: () => ({ live, maxLive, created, ended }) };
}

function withEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES;
  if (value === undefined) delete process.env.BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES;
  else process.env.BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES;
    else process.env.BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES = previous;
  }
}

function testLimitResolution(): void {
  assert.strictEqual(TILION_MAX_PARALLEL_RECOVERY_PROBES_DEFAULT, 2);
  assert.strictEqual(
    withEnv(undefined, () => maxParallelRecoveryProbes('tilion')),
    2
  );
  assert.strictEqual(
    withEnv('3', () => maxParallelRecoveryProbes('tilion')),
    3
  );
  assert.strictEqual(
    withEnv('0', () => maxParallelRecoveryProbes('tilion')),
    2,
    'invalid override keeps the default'
  );
  for (const provider of ['kernel', 'steel', 'browser-use']) {
    assert.strictEqual(
      maxParallelRecoveryProbes(provider),
      null,
      `${provider} must stay unbounded`
    );
  }
}

async function testTilionLiveCandidatesBounded(): Promise<void> {
  const fake = countingDependencies('lane-4', 'tilion_direct');
  const winner = await runLaneConfigSearch(
    configsFor('tilion'),
    LANES,
    withProviderProbeLimits(fake.dependencies),
    { searchDeadlineMs: 20_000 }
  );
  await sleep(300); // aborted siblings finish releasing
  const stats = fake.stats();
  assert.strictEqual(winner.config.key, 'tilion_direct');
  assert.ok(stats.maxLive <= 2, `Tilion recovery held ${stats.maxLive} live candidates (cap 2)`);
  assert.strictEqual(stats.live, 0, 'every candidate was released or promoted');
  assert.ok(stats.ended.some((entry) => entry.startsWith('promoted:')));
}

async function testKernelUnchanged(): Promise<void> {
  const fake = countingDependencies('lane-4', 'kernel_isp');
  await runLaneConfigSearch(
    configsFor('kernel'),
    LANES,
    withProviderProbeLimits(fake.dependencies),
    {
      searchDeadlineMs: 20_000,
    }
  );
  await sleep(300);
  assert.ok(
    fake.stats().maxLive > 2,
    `Kernel lanes must still probe in parallel (max ${fake.stats().maxLive})`
  );
}

async function testAbortWhileWaitingReleasesNothingTwice(): Promise<void> {
  const fake = countingDependencies('none', 'none');
  const limited = withProviderProbeLimits(fake.dependencies);
  const [config] = configsFor('tilion');
  const first = await limited.create(config!, new AbortController().signal);
  const second = await limited.create(config!, new AbortController().signal);
  const waiting = new AbortController();
  const third = limited.create(config!, waiting.signal);
  await sleep(50);
  assert.strictEqual(fake.stats().created, 2, 'a third Tilion candidate must wait for a slot');
  waiting.abort();
  await assert.rejects(third, /lane_aborted/);
  await limited.release(config!, first);
  await limited.release(config!, first); // a duplicate release must not free a second slot
  const fourth = await limited.create(config!, new AbortController().signal);
  const fifth = limited.create(config!, new AbortController().signal);
  await sleep(50);
  assert.strictEqual(fake.stats().created, 3, 'only the one freed slot was reusable');
  await limited.release(config!, second);
  await fifth;
  assert.strictEqual(fake.stats().created, 4);
  void fourth;
}

async function main(): Promise<void> {
  testLimitResolution();
  await testTilionLiveCandidatesBounded();
  await testKernelUnchanged();
  await testAbortWhileWaitingReleasesNothingTwice();
  process.stdout.write(
    'PASS recovery probe limit: Tilion bounded to 2 live candidates, others unchanged\n'
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
