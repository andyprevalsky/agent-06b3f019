#!/usr/bin/env tsx
/**
 * Tilion challenge-recovery building blocks: candidate availability (kill
 * switch + key), preferred-config shape, live-session key mapping, and the
 * single-CDP-client candidate creation contract.
 */
import assert from 'node:assert';
import type { Browser } from 'playwright';
import {
  availableBrowserRecoveryCandidates,
  browserRecoveryCandidates,
  buildPreferredBrowserConfig,
  compatiblePreferredBrowserConfig,
  createTilionRecoveryCandidate,
  recoveryConfigKeyForSession,
  type BrowserConfigSearchRuntimeDependencies,
} from '../../providers/browser/challengeRecovery';

const LOCATION = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tilionKeys(): string[] {
  return availableBrowserRecoveryCandidates(LOCATION)
    .filter((candidate) => candidate.provider === 'tilion')
    .map((candidate) => candidate.key);
}

function testTilionCandidates(): void {
  const tilion = browserRecoveryCandidates(LOCATION).filter((c) => c.provider === 'tilion');
  assert.deepStrictEqual(tilion, [
    {
      key: 'tilion_residential',
      provider: 'tilion',
      proxyMode: 'residential_city',
      tilionProxyType: 'residential',
    },
    {
      key: 'tilion_mobile',
      provider: 'tilion',
      proxyMode: 'mobile_city',
      tilionProxyType: 'mobile',
    },
  ]);
  assert.deepStrictEqual(
    browserRecoveryCandidates({ country: 'DE' })
      .filter((c) => c.provider === 'tilion')
      .map((c) => c.proxyMode),
    ['residential_country', 'mobile_country']
  );
  // The Stripe-capable Steel focus is unchanged by Tilion.
  assert.ok(
    browserRecoveryCandidates(LOCATION, { preferSteel: true }).every((c) => c.provider === 'steel')
  );

  withEnv({ TILION_API_KEY: 'test-key', BROWSER_AGENT_TILION_ENABLED: undefined }, () =>
    assert.deepStrictEqual(tilionKeys(), ['tilion_residential', 'tilion_mobile'])
  );
  withEnv({ TILION_API_KEY: 'test-key', BROWSER_AGENT_TILION_ENABLED: 'false' }, () =>
    assert.deepStrictEqual(tilionKeys(), [], 'kill switch must keep Tilion out of recovery')
  );
  withEnv({ TILION_API_KEY: ' ', BROWSER_AGENT_TILION_ENABLED: 'true' }, () =>
    assert.deepStrictEqual(tilionKeys(), [], 'unkeyed Tilion must not consume recovery budget')
  );
}

function testPreferredConfig(): void {
  const config = browserRecoveryCandidates(LOCATION).find((c) => c.key === 'tilion_mobile')!;
  const preferred = buildPreferredBrowserConfig(config, LOCATION);
  assert.strictEqual(preferred.provider, 'tilion');
  assert.strictEqual(preferred.tilionProxyType, 'mobile');
  assert.strictEqual(preferred.kernelProxyType, undefined);
  assert.strictEqual(preferred.steelProxyMode, undefined);
  const roundTrip = JSON.parse(JSON.stringify(preferred)) as unknown;
  assert.deepStrictEqual(compatiblePreferredBrowserConfig(roundTrip, LOCATION), roundTrip);
  // Location compatibility applies to Tilion like every provider.
  assert.strictEqual(
    compatiblePreferredBrowserConfig(roundTrip, { ...LOCATION, city: 'OAKLAND' }),
    null
  );
  // A Tilion preference without a usable exit type is rejected.
  for (const tilionProxyType of [undefined, 'isp', 'datacenter']) {
    assert.strictEqual(
      compatiblePreferredBrowserConfig({ ...preferred, ...{ tilionProxyType } }, LOCATION),
      null,
      `accepted tilionProxyType=${String(tilionProxyType)}`
    );
  }
  assert.strictEqual(
    compatiblePreferredBrowserConfig({ ...preferred, provider: 'browserbase' }, LOCATION),
    null
  );
}

function testRecoveryConfigKeyForTilionSession(): void {
  assert.strictEqual(recoveryConfigKeyForSession('tilion', 'residential'), 'tilion_residential');
  assert.strictEqual(
    recoveryConfigKeyForSession('tilion', 'residential_city'),
    'tilion_residential'
  );
  assert.strictEqual(recoveryConfigKeyForSession('tilion', null), 'tilion_residential');
  assert.strictEqual(recoveryConfigKeyForSession('tilion', 'mobile'), 'tilion_mobile');
  assert.strictEqual(recoveryConfigKeyForSession('tilion', 'mobile_state'), 'tilion_mobile');
  assert.strictEqual(recoveryConfigKeyForSession('tilion', 'datacenter'), undefined);
}

function createdTilion(validationBrowser: Browser | null) {
  return {
    sessionId: 'tilion-candidate',
    debugUrl: 'https://tilion.invalid/live',
    wsUrl: 'wss://tilion.invalid/cdp?token=t',
    proxySource: 'tilion_mobile',
    proxyLocation: LOCATION,
    profileId: null,
    profileSource: 'challenge_candidate_ephemeral',
    validationBrowser,
  } as const;
}

type TilionCandidateDependencies = Pick<
  BrowserConfigSearchRuntimeDependencies,
  'createTilion' | 'connectTilionValidation' | 'releaseTilion'
>;

async function testCandidateReusesCreateTimeClient(): Promise<void> {
  const client = { contexts: () => [] } as unknown as Browser;
  const requested: unknown[] = [];
  let connects = 0;
  const dependencies: TilionCandidateDependencies = {
    createTilion: async (location, options) => {
      requested.push({ location, options });
      return createdTilion(client);
    },
    connectTilionValidation: async () => {
      connects += 1;
      return client;
    },
    releaseTilion: async () => assert.fail('a healthy candidate must not be released'),
  };
  const session = await createTilionRecoveryCandidate(dependencies, LOCATION, 'mobile');
  assert.strictEqual(session.provider, 'tilion');
  assert.strictEqual(session.validationBrowser, client);
  assert.strictEqual(connects, 0, 'a second CDP client would be closed with 4409');
  assert.deepStrictEqual(requested, [{ location: LOCATION, options: { proxyType: 'mobile' } }]);
}

async function testCandidateOpensTheOnlyClientWhenCreateHandsNone(): Promise<void> {
  const client = { contexts: () => [] } as unknown as Browser;
  const connected: string[] = [];
  const session = await createTilionRecoveryCandidate(
    {
      createTilion: async () => createdTilion(null),
      connectTilionValidation: async (wsUrl) => {
        connected.push(wsUrl);
        return client;
      },
      releaseTilion: async () => assert.fail('a healthy candidate must not be released'),
    },
    LOCATION,
    'residential'
  );
  assert.deepStrictEqual(connected, ['wss://tilion.invalid/cdp?token=t']);
  assert.strictEqual(session.validationBrowser, client);
}

async function testFailedConnectReleasesPaidSession(): Promise<void> {
  const released: string[] = [];
  await assert.rejects(
    createTilionRecoveryCandidate(
      {
        createTilion: async () => createdTilion(null),
        connectTilionValidation: async () => {
          throw new Error('4409 another client is attached to this session');
        },
        releaseTilion: async (sessionId) => {
          released.push(sessionId);
        },
      },
      LOCATION,
      'residential'
    ),
    /4409/
  );
  assert.deepStrictEqual(released, ['tilion-candidate']);
}

async function main(): Promise<void> {
  testTilionCandidates();
  testPreferredConfig();
  testRecoveryConfigKeyForTilionSession();
  await testCandidateReusesCreateTimeClient();
  await testCandidateOpensTheOnlyClientWhenCreateHandsNone();
  await testFailedConnectReleasesPaidSession();
  process.stdout.write('PASS Tilion challenge recovery candidates and preferred config\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
