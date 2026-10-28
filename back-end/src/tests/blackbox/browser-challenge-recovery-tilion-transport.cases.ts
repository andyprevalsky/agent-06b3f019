/** Tilion residential tunnel-failure recovery cases (tilion_direct egress). Registered by browser-challenge-recovery.blackbox.ts. */
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  searchAndPromoteBrowserConfig,
  type BrowserConfigSearchRuntimeDependencies,
} from '../../providers/browser/challengeRecovery';
import {
  assert,
  seedRun,
  TILION_DEFAULT_ENV,
  withEnv,
  type RegisterTest,
} from './browser-challenge-recovery-tilion.support';

export function registerTilionTransportCases(test: RegisterTest): void {
  /** Recovery runtime whose probe passes only the given config keys. */
  function scriptedRecoveryRuntime(cleanKeys: string[]) {
    const createdKeys: string[] = [];
    const tilionCreates: unknown[] = [];
    const released: string[] = [];
    const candidate = (provider: string, proxySource: string) => ({
      sessionId: `${provider}-${proxySource}-${randomUUID()}`,
      debugUrl: `https://${provider}.invalid/live`,
      wsUrl: `wss://${provider}.invalid/cdp`,
      proxySource,
      proxyLocation: DEFAULT_GEOLOCATION,
      profileId: null,
      profileSource: 'challenge_candidate_ephemeral',
      validationBrowser: { close: async () => undefined } as unknown as Browser,
    });
    const runtime: BrowserConfigSearchRuntimeDependencies = {
      createKernel: async (_agentId, _location, proxy) =>
        candidate('kernel', `${proxy.type}_${proxy.specificity}`),
      createSteel: async (input) => candidate('steel', input.proxyMode),
      createBrowserUse: async () => {
        throw new Error('Browser Use is disabled in this test');
      },
      createTilion: async (_location, options) => {
        tilionCreates.push(options);
        return candidate('tilion', `tilion_${options.proxyType}`);
      },
      releaseKernel: async (sessionId) => void released.push(sessionId),
      releaseSteel: async (sessionId) => void released.push(sessionId),
      releaseBrowserUse: async (sessionId) => void released.push(sessionId),
      releaseTilion: async (sessionId) => void released.push(sessionId),
      refreshTilionConnectUrl: async (sessionId) => `wss://tilion.invalid/${sessionId}?token=fresh`,
      announceBinding: async () => undefined,
      probe: async (session, _url, _storage, logContext) => {
        createdKeys.push(String(logContext?.configKey));
        const clean = cleanKeys.includes(String(logContext?.configKey));
        return { stablePasses: clean ? 1 : 0, attempts: 1, latencyMs: 1, paymentCdnOk: true };
      },
    };
    return { runtime, createdKeys, tilionCreates, released };
  }

  const TUNNEL_RECOVERY = {
    targetUrl: 'https://order.online/business/BlueBottleCoffee-156787',
    storageState: { cookies: [], origins: [] },
    recoveryReason: 'critical third-party resource blocked',
    blockedResourceUrl: 'https://js.stripe.com/v3',
    fingerprintInjection: null,
  };

  async function testTilionTunnelFailurePromotesDirectEgress(): Promise<void> {
    const run = await seedRun('tilion', 'residential_city');
    const scripted = scriptedRecoveryRuntime(['tilion_direct']);
    try {
      const result = await withEnv(TILION_DEFAULT_ENV, async () =>
        searchAndPromoteBrowserConfig(
          { taskId: run.session.id, userId: run.owner.userId, ...TUNNEL_RECOVERY },
          scripted.runtime
        )
      );
      assert(
        scripted.createdKeys[0] === 'tilion_direct',
        `tilion_direct was not probed first: ${JSON.stringify(scripted.createdKeys)}`
      );
      assert(
        JSON.stringify(scripted.tilionCreates[0]) === JSON.stringify({ proxyType: 'direct' }),
        `direct egress not requested: ${JSON.stringify(scripted.tilionCreates)}`
      );
      assert(result.config_key === 'tilion_direct', `winner: ${result.config_key}`);
      assert(
        result.recovery_action === 'config_selected',
        'same provider must not read as a switch'
      );
      const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: run.session.id } });
      assert(
        row.provider === 'tilion' && row.proxyTier === 'direct',
        `row: ${row.provider}/${row.proxyTier}`
      );
      assert(scripted.released.includes(run.session.sessionId), 'residential session not released');
      const context = await prisma.browserContext.findUniqueOrThrow({
        where: { id: run.context.id },
      });
      const preferred = context.preferredBrowserConfig as { tilionProxyType?: string } | null;
      assert(preferred?.tilionProxyType === 'direct', `preferred: ${JSON.stringify(preferred)}`);
    } finally {
      await run.cleanup();
    }
  }

  test(
    'Tilion residential tunnel failure probes and promotes tilion_direct first',
    testTilionTunnelFailurePromotesDirectEgress
  );

  async function testDirectChallengedFallsThroughToOtherProviders(): Promise<void> {
    // A site that challenges datacenter IPs: the classifier rejects direct and
    // the search moves on to the other providers in their existing order.
    const run = await seedRun('tilion', 'residential_city');
    const scripted = scriptedRecoveryRuntime(['steel_fixed']);
    try {
      const result = await withEnv(TILION_DEFAULT_ENV, async () =>
        searchAndPromoteBrowserConfig(
          { taskId: run.session.id, userId: run.owner.userId, ...TUNNEL_RECOVERY },
          scripted.runtime
        )
      );
      assert(
        JSON.stringify(scripted.createdKeys.slice(0, 2)) ===
          JSON.stringify(['tilion_direct', 'steel_fixed']),
        `unexpected probe order: ${JSON.stringify(scripted.createdKeys)}`
      );
      assert(result.config_key === 'steel_fixed', `winner: ${result.config_key}`);
      assert(result.recovery_action === 'provider_switched', result.recovery_action);
      assert(
        scripted.released.some((id) => id.startsWith('tilion-tilion_direct')),
        'challenged direct candidate was not released'
      );
    } finally {
      await run.cleanup();
    }
  }

  test(
    'a challenged tilion_direct falls through to the other providers',
    testDirectChallengedFallsThroughToOtherProviders
  );
}
