/**
 * BROWSER_RECOVERY_SAME_PROVIDER_ONLY rotate_ip cases (experiment knob, default
 * off). Registered by browser-challenge-recovery.blackbox.ts.
 */
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  searchAndPromoteBrowserConfig,
  type BrowserConfigSearchRuntimeDependencies,
} from '../../providers/browser/challengeRecovery';
import {
  rotateBrowserProxy,
  SameProviderRotationExhaustedError,
} from '../../providers/browserSessionResume';
import {
  assert,
  fakeProviderOperations,
  seedRun,
  TILION_DEFAULT_ENV,
  withEnv,
  type RegisterTest,
} from './browser-challenge-recovery-tilion.support';

export function registerSameProviderCases(test: RegisterTest): void {
  async function rotationAtPosition3(env: Record<string, string | undefined>) {
    const run = await seedRun('tilion', 'residential');
    const fake = fakeProviderOperations();
    await prisma.browserSession.update({
      where: { id: run.session.id },
      data: { proxyRotationCount: 2 },
    });
    try {
      const outcome = await withEnv({ ...TILION_DEFAULT_ENV, ...env }, async () =>
        rotateBrowserProxy(run.session.id, run.owner.userId, undefined, {}, fake.dependencies).then(
          (result) => ({ result, error: null as unknown }),
          (error: unknown) => ({ result: null, error })
        )
      );
      const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: run.session.id } });
      return {
        ...outcome,
        steps: fake.steps,
        count: row.proxyRotationCount,
        provider: row.provider,
      };
    } finally {
      await run.cleanup();
    }
  }

  async function testLockedLadderStaysOnTilion(): Promise<void> {
    const control = await rotationAtPosition3({ BROWSER_RECOVERY_SAME_PROVIDER_ONLY: undefined });
    assert(control.error === null, `control failed: ${String(control.error)}`);
    assert(
      control.steps[0]?.provider !== 'tilion',
      `knob off must keep the cross-provider ladder: ${JSON.stringify(control.steps)}`
    );

    const locked = await rotationAtPosition3({ BROWSER_RECOVERY_SAME_PROVIDER_ONLY: 'true' });
    assert(locked.error === null, `locked rotation failed: ${String(locked.error)}`);
    assert(
      JSON.stringify(locked.steps) ===
        JSON.stringify([
          { provider: 'tilion', proxyType: 'residential', recoveryAction: 'ip_rotated' },
        ]),
      `locked ladder left Tilion: ${JSON.stringify(locked.steps)}`
    );
    assert(locked.provider === 'tilion', `persisted provider ${locked.provider}`);
    assert(
      locked.result?.next_recovery === 'rotate_tilion_residential_ip',
      `${locked.result?.next_recovery}`
    );
  }

  async function testLockedLadderWithNoRungIsTyped(): Promise<void> {
    const outcome = await rotationAtPosition3({
      BROWSER_RECOVERY_SAME_PROVIDER_ONLY: 'true',
      BROWSER_AGENT_TILION_ENABLED: 'false',
    });
    assert(
      outcome.error instanceof SameProviderRotationExhaustedError,
      `expected the typed no-same-provider-rung result, got ${String(outcome.error)}`
    );
    assert(
      /NO_SAME_PROVIDER_RUNG_LEFT/.test((outcome.error as Error).message),
      'message names the knob outcome'
    );
    assert(
      outcome.steps.length === 0,
      `a provider was still rotated: ${JSON.stringify(outcome.steps)}`
    );
    assert(outcome.count === 2, `the reserved rotation was not refunded: ${outcome.count}`);
  }

  async function searchFromTilion(env: Record<string, string | undefined>) {
    const run = await seedRun('tilion', 'residential_city');
    const created: string[] = [];
    const candidate = (provider: string, proxySource: string) => {
      created.push(provider);
      return {
        sessionId: `${provider}-${proxySource}-${created.length}`,
        debugUrl: `https://${provider}.invalid/live`,
        wsUrl: `wss://${provider}.invalid/cdp`,
        proxySource,
        proxyLocation: DEFAULT_GEOLOCATION,
        profileId: null,
        profileSource: 'challenge_candidate_ephemeral',
        validationBrowser: { close: async () => undefined } as unknown as Browser,
      };
    };
    const runtime: BrowserConfigSearchRuntimeDependencies = {
      createKernel: async (_agentId, _location, proxy) => candidate('kernel', `${proxy.type}`),
      createSteel: async (input) => candidate('steel', input.proxyMode),
      createBrowserUse: async () => candidate('browser-use', 'residential'),
      createTilion: async (_location, options) =>
        candidate('tilion', `tilion_${options.proxyType}`),
      releaseKernel: async () => undefined,
      releaseSteel: async () => undefined,
      releaseBrowserUse: async () => undefined,
      releaseTilion: async () => undefined,
      announceBinding: async () => undefined,
      probe: async (_session, _url, _storage, logContext) => {
        const clean = logContext?.configKey === 'steel_fixed';
        return { stablePasses: clean ? 1 : 0, attempts: 1, latencyMs: 1, paymentCdnOk: true };
      },
    };
    try {
      const outcome = await withEnv({ ...TILION_DEFAULT_ENV, ...env }, async () =>
        searchAndPromoteBrowserConfig(
          {
            taskId: run.session.id,
            userId: run.owner.userId,
            targetUrl: 'https://order.online/business/BlueBottleCoffee-156787',
            storageState: { cookies: [], origins: [] },
            recoveryReason: 'critical third-party resource blocked',
            fingerprintInjection: null,
          },
          runtime
        ).then(
          (result) => ({ result, error: null as unknown }),
          (error: unknown) => ({ result: null, error })
        )
      );
      return { ...outcome, created };
    } finally {
      await run.cleanup();
    }
  }

  async function testLockedSearchNeverCreatesOtherProviders(): Promise<void> {
    const control = await searchFromTilion({ BROWSER_RECOVERY_SAME_PROVIDER_ONLY: undefined });
    assert(
      control.result?.config_key === 'steel_fixed',
      `control winner: ${control.result?.config_key}`
    );
    assert(control.created.includes('steel'), 'control must probe other providers');

    const locked = await searchFromTilion({ BROWSER_RECOVERY_SAME_PROVIDER_ONLY: 'true' });
    assert(locked.created.length > 0, 'locked search probed nothing');
    assert(
      locked.created.every((provider) => provider === 'tilion'),
      `locked search created other providers: ${JSON.stringify(locked.created)}`
    );
    assert(
      locked.result === null,
      'only steel_fixed is clean, so a locked Tilion search has no winner'
    );
  }

  test(
    'same-provider knob: challenge recovery only creates and probes the current provider',
    testLockedSearchNeverCreatesOtherProviders
  );
  test(
    'same-provider knob: rotate_ip at a switch rung stays on Tilion',
    testLockedLadderStaysOnTilion
  );
  test(
    'same-provider knob: no same-provider rung returns a typed result and refunds the rotation',
    testLockedLadderWithNoRungIsTyped
  );
}
