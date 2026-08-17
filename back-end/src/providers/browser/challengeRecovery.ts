import type { Prisma } from '@prisma/client';
import type { Browser, Cookie } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { createSteelRecoverySession, releaseSteelRemoteSession } from '../steel/session';
import { waitForProviderSolver } from './challengePageDetect';
import {
  createKernelRecoverySession,
  releaseKernelRemoteSession,
  type KernelRecoveryProxySpecificity,
} from './kernel';
import type { KernelProxyType } from './kernelProxy';
import {
  blockedResourceRequiresPaymentCdn,
  probePaymentCdnReachable,
} from './paymentCdnProbe';
import { recoveryOriginStorageScript } from './recoveryOriginStorage';
import type { BrowserProviderName } from './types';

export { challengeDetectionReason, pageLooksChallenged } from './challengePageDetect';
export {
  blockedResourceRequiresPaymentCdn,
  targetLooksLikePaymentDocument,
} from './paymentCdnProbe';

const log = createLogger('BrowserChallengeRecovery');

export interface BrowserRecoveryConfig {
  key: string;
  provider: BrowserProviderName;
  proxyMode: string;
  kernelProxyType?: KernelProxyType;
  kernelSpecificity?: KernelRecoveryProxySpecificity;
  steelProxyMode?: 'managed' | 'fixed';
}

export interface PreferredBrowserConfig {
  version: 1;
  provider: BrowserProviderName;
  proxyMode: string;
  kernelProxyType?: KernelProxyType;
  kernelSpecificity?: KernelRecoveryProxySpecificity;
  steelProxyMode?: 'managed' | 'fixed';
  proxyLocation: ProxyGeoLocation;
  learnedAt: string;
}

export interface RecoveryCandidateSession {
  provider: BrowserProviderName;
  sessionId: string;
  debugUrl: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: string | null;
  profileSource: string;
  validationBrowser: Browser;
}

export interface CandidateProbeResult {
  stablePasses: number;
  attempts: number;
  latencyMs: number;
  /**
   * True when the candidate can fetch js.stripe.com AND load Stripe.js
   * (window.Stripe). api.stripe.com is ranked via paymentCdnHosts but not
   * required — live steel_managed loads Stripe.js while api.stripe.com fails.
   */
  paymentCdnOk: boolean;
  /** Per-host tunnel + stripe.js script-load results (for ranking + logs). */
  paymentCdnHosts?: Record<string, boolean>;
}

export interface SuccessfulRecoveryCandidate {
  config: BrowserRecoveryConfig;
  session: RecoveryCandidateSession;
  probe: CandidateProbeResult;
}

export interface ConfigSearchDependencies {
  create: (config: BrowserRecoveryConfig) => Promise<RecoveryCandidateSession>;
  probe: (
    config: BrowserRecoveryConfig,
    session: RecoveryCandidateSession
  ) => Promise<CandidateProbeResult>;
  promote: (winner: SuccessfulRecoveryCandidate) => Promise<void>;
  release: (config: BrowserRecoveryConfig, session: RecoveryCandidateSession) => Promise<void>;
}

export interface BrowserConfigSearchRuntimeDependencies {
  createKernel: typeof createKernelRecoverySession;
  createSteel: typeof createSteelRecoverySession;
  releaseKernel: typeof releaseKernelRemoteSession;
  releaseSteel: typeof releaseSteelRemoteSession;
  probe: typeof probeCandidateBrowser;
}

function bestSpecificity(location: ProxyGeoLocation): KernelRecoveryProxySpecificity {
  if (location.city) return 'city';
  if (location.state) return 'state';
  return 'country';
}

/** The six independent browser/IP configurations searched after cookie isolation. */
export function browserRecoveryCandidates(location: ProxyGeoLocation): BrowserRecoveryConfig[] {
  const fallbackSpecificity = bestSpecificity(location);
  const candidates: BrowserRecoveryConfig[] = [];
  if (location.city) {
    candidates.push({
      key: 'kernel_residential_city',
      provider: 'kernel',
      proxyMode: 'residential_city',
      kernelProxyType: 'residential',
      kernelSpecificity: 'city',
    });
  }
  if (location.state) {
    candidates.push({
      key: 'kernel_residential_state',
      provider: 'kernel',
      proxyMode: 'residential_state',
      kernelProxyType: 'residential',
      kernelSpecificity: 'state',
    });
  }
  if (!location.city && !location.state) {
    candidates.push({
      key: 'kernel_residential_country',
      provider: 'kernel',
      proxyMode: 'residential_country',
      kernelProxyType: 'residential',
      kernelSpecificity: 'country',
    });
  }
  candidates.push(
    {
      key: 'kernel_mobile',
      provider: 'kernel',
      proxyMode: `mobile_${fallbackSpecificity}`,
      kernelProxyType: 'mobile',
      kernelSpecificity: fallbackSpecificity,
    },
    {
      key: 'kernel_isp',
      provider: 'kernel',
      proxyMode: `isp_${fallbackSpecificity}`,
      kernelProxyType: 'isp',
      kernelSpecificity: fallbackSpecificity,
    },
    {
      key: 'steel_managed',
      provider: 'steel',
      proxyMode: 'managed',
      steelProxyMode: 'managed',
    },
    {
      key: 'steel_fixed',
      provider: 'steel',
      proxyMode: 'fixed',
      steelProxyMode: 'fixed',
    }
  );
  return candidates;
}

function candidateScore(
  candidate: SuccessfulRecoveryCandidate,
  avoidConfigKey?: string
): [number, number, number] {
  // Hard filters (CF-stable, optional paymentCdnOk) already applied. Among
  // survivors: prefer the currently-failing exit least, then lowest latency.
  // No soft payment-CDN ranking — a config either passed the hard filter or not.
  const isAvoided = Boolean(avoidConfigKey && candidate.config.key === avoidConfigKey);
  return [-candidate.probe.stablePasses, isAvoided ? 1 : 0, candidate.probe.latencyMs];
}

/** Map a live session's provider + proxyTier back to a recovery candidate key. */
export function recoveryConfigKeyForSession(
  provider: string | null | undefined,
  proxyTier: string | null | undefined
): string | undefined {
  const tier = (proxyTier || '').trim().toLowerCase();
  if ((provider || '').toLowerCase() === 'steel') {
    if (tier === 'fixed') return 'steel_fixed';
    if (tier === 'managed' || tier === '') return 'steel_managed';
    return undefined;
  }
  if ((provider || '').toLowerCase() === 'kernel') {
    if (tier.startsWith('isp')) return 'kernel_isp';
    if (tier.startsWith('mobile')) return 'kernel_mobile';
    if (tier.includes('residential_state') || tier === 'residential_state') {
      return 'kernel_residential_state';
    }
    if (tier.includes('residential_city') || tier === 'residential_city') {
      return 'kernel_residential_city';
    }
    if (tier.startsWith('residential')) return 'kernel_residential_city';
  }
  return undefined;
}

export interface ParallelConfigSearchOptions {
  /** Deprioritize this candidate key (e.g. the live exit that just failed payment CDN). */
  avoidConfigKey?: string;
  /**
   * When true (checkout / payment URLs), refuse to promote a winner that did not
   * clear Stripe.js — CF-only clears are not recovery success for payment docs.
   */
  requirePaymentCdn?: boolean;
}

/** Create/probe all candidates concurrently, then atomically promote one winner. */
export async function runParallelBrowserConfigSearch(
  configs: BrowserRecoveryConfig[],
  dependencies: ConfigSearchDependencies,
  options: ParallelConfigSearchOptions = {}
): Promise<SuccessfulRecoveryCandidate> {
  const avoidConfigKey = options.avoidConfigKey;
  const requirePaymentCdn = Boolean(options.requirePaymentCdn);
  const attempts = await Promise.allSettled(
    configs.map(async (config) => {
      try {
        const session = await dependencies.create(config);
        try {
          const probe = await dependencies.probe(config, session);
          log.info('Challenge recovery candidate probed', {
            configKey: config.key,
            provider: config.provider,
            proxyMode: config.proxyMode,
            stablePasses: probe.stablePasses,
            attempts: probe.attempts,
            paymentCdnOk: probe.paymentCdnOk,
            paymentCdnHosts: probe.paymentCdnHosts ?? {},
            latencyMs: probe.latencyMs,
          });
          return { config, session, probe };
        } catch (error) {
          log.warn('Challenge recovery candidate probe failed', {
            configKey: config.key,
            provider: config.provider,
            proxyMode: config.proxyMode,
            error: error instanceof Error ? error.message : String(error),
          });
          await dependencies.release(config, session).catch(() => {});
          throw error;
        }
      } catch (error) {
        log.warn('Challenge recovery candidate create/probe failed', {
          configKey: config.key,
          provider: config.provider,
          proxyMode: config.proxyMode,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })
  );
  const successful = attempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []
  );
  const ranked = successful
    .filter((candidate) => candidate.probe.stablePasses > 0)
    .filter((candidate) => !requirePaymentCdn || candidate.probe.paymentCdnOk)
    .sort((left, right) => {
      const leftScore = candidateScore(left, avoidConfigKey);
      const rightScore = candidateScore(right, avoidConfigKey);
      for (let index = 0; index < leftScore.length; index += 1) {
        const delta = leftScore[index]! - rightScore[index]!;
        if (delta !== 0) return delta;
      }
      return 0;
    });
  // Prefer fully-stable (passes === attempts). If Cloudflare only clears one of
  // two probe loads, still promote the best partial winner — the agent live
  // navigation verify remains the hard gate before recovery success. On payment
  // documents, Stripe.js must also have loaded (requirePaymentCdn).
  const winner =
    ranked.find((candidate) => candidate.probe.stablePasses === candidate.probe.attempts) ??
    ranked[0];
  if (winner === undefined) {
    const stableWithoutStripe = successful.filter(
      (candidate) => candidate.probe.stablePasses > 0 && !candidate.probe.paymentCdnOk
    );
    log.error('Challenge recovery found no stable browser configuration', {
      candidateCount: configs.length,
      successfulProbeCount: successful.length,
      requirePaymentCdn,
      stableWithoutStripeCount: stableWithoutStripe.length,
      configKeys: configs.map((config) => config.key),
      paymentCdnHosts: stableWithoutStripe.map((candidate) => ({
        configKey: candidate.config.key,
        hosts: candidate.probe.paymentCdnHosts ?? {},
      })),
    });
    await Promise.allSettled(
      successful.map((candidate) => dependencies.release(candidate.config, candidate.session))
    );
    if (requirePaymentCdn && stableWithoutStripe.length > 0) {
      throw new Error(
        'No browser configuration cleared the challenge with Stripe.js loaded ' +
          `(${stableWithoutStripe.length} CF-stable candidate(s) failed payment CDN / Stripe.js)`
      );
    }
    throw new Error('No stable browser configuration cleared the challenge');
  }

  log.info('Challenge recovery promoting stable winner', {
    configKey: winner.config.key,
    provider: winner.config.provider,
    proxyMode: winner.config.proxyMode,
    stablePasses: winner.probe.stablePasses,
    attempts: winner.probe.attempts,
    paymentCdnOk: winner.probe.paymentCdnOk,
    paymentCdnHosts: winner.probe.paymentCdnHosts ?? {},
    requirePaymentCdn,
    avoidConfigKey: avoidConfigKey ?? null,
    partial: winner.probe.stablePasses < winner.probe.attempts,
    latencyMs: winner.probe.latencyMs,
  });
  try {
    await dependencies.promote(winner);
  } catch (error) {
    await Promise.allSettled(
      successful.map((candidate) => dependencies.release(candidate.config, candidate.session))
    );
    throw error;
  }
  await Promise.allSettled(
    successful
      .filter((candidate) => candidate !== winner)
      .map((candidate) => dependencies.release(candidate.config, candidate.session))
  );
  return winner;
}

export async function probeCandidateBrowser(
  session: RecoveryCandidateSession,
  targetUrl: string,
  storageState: Record<string, unknown>,
  logContext: { configKey?: string; provider?: string; proxyMode?: string } = {}
): Promise<CandidateProbeResult> {
  const started = Date.now();
  let stablePasses = 0;
  let paymentCdnOk = false;
  let paymentCdnHosts: Record<string, boolean> = {};
  const attempts = 2;
  try {
    const context = session.validationBrowser.contexts()[0];
    if (context === undefined) {
      throw new Error(`Recovery candidate ${session.sessionId} has no default browser context`);
    }
    const cookies = Array.isArray(storageState.cookies) ? (storageState.cookies as Cookie[]) : [];
    if (cookies.length > 0) await context.addCookies(cookies);
    const origins = Array.isArray(storageState.origins) ? storageState.origins : [];
    if (origins.length > 0) {
      await context.addInitScript(recoveryOriginStorageScript(storageState));
    }
    const page = context.pages()[0] ?? (await context.newPage());
    for (let index = 0; index < attempts; index += 1) {
      const response = await page
        .goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        .catch(() => null);
      if (origins.length > 0) {
        await page.evaluate(async () => {
          const recoveryGlobal = globalThis as typeof globalThis & {
            __naviRestoreRecoveryStorage?: () => Promise<void>;
          };
          await recoveryGlobal.__naviRestoreRecoveryStorage?.();
        });
      }
      const attempt = await waitForProviderSolver(page, response);
      if (!attempt.clean) {
        log.info('Challenge recovery candidate probe attempt still challenged', {
          ...logContext,
          attempt: index + 1,
          attempts,
          reason: attempt.reason,
          title: attempt.title.slice(0, 200),
        });
        break;
      }
      log.info('Challenge recovery candidate probe attempt clean', {
        ...logContext,
        attempt: index + 1,
        attempts,
        title: attempt.title.slice(0, 200),
      });
      stablePasses += 1;
    }
    if (stablePasses > 0) {
      const paymentProbe = await probePaymentCdnReachable(page);
      paymentCdnOk = paymentProbe.paymentCdnOk;
      paymentCdnHosts = paymentProbe.paymentCdnHosts;
      log.info('Challenge recovery candidate payment CDN probe', {
        ...logContext,
        paymentCdnOk,
        paymentCdnHosts,
      });
    }
  } finally {
    // Closing this CDP client leaves the remote default context (including any
    // solver-refreshed challenge cookies) alive for atomic promotion.
    await session.validationBrowser.close().catch(() => {});
  }
  return {
    stablePasses,
    attempts,
    latencyMs: Date.now() - started,
    paymentCdnOk,
    paymentCdnHosts,
  };
}

export function buildPreferredBrowserConfig(
  config: BrowserRecoveryConfig,
  proxyLocation: ProxyGeoLocation
): PreferredBrowserConfig {
  return {
    version: 1,
    provider: config.provider,
    proxyMode: config.proxyMode,
    ...(config.kernelProxyType ? { kernelProxyType: config.kernelProxyType } : {}),
    ...(config.kernelSpecificity ? { kernelSpecificity: config.kernelSpecificity } : {}),
    ...(config.steelProxyMode ? { steelProxyMode: config.steelProxyMode } : {}),
    proxyLocation,
    learnedAt: new Date().toISOString(),
  };
}

export function compatiblePreferredBrowserConfig(
  raw: unknown,
  requestedLocation: ProxyGeoLocation
): PreferredBrowserConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<PreferredBrowserConfig>;
  if (candidate.version !== 1 || !['kernel', 'steel'].includes(String(candidate.provider))) {
    return null;
  }
  const learnedLocation = candidate.proxyLocation;
  if (!learnedLocation || learnedLocation.country !== requestedLocation.country) return null;
  if (learnedLocation.state && learnedLocation.state !== requestedLocation.state) return null;
  if (learnedLocation.city && learnedLocation.city !== requestedLocation.city) return null;
  if (candidate.provider === 'kernel' && !candidate.kernelProxyType) return null;
  if (candidate.provider === 'steel' && !candidate.steelProxyMode) return null;
  return candidate as PreferredBrowserConfig;
}

const browserConfigSearchRuntimeDependencies: BrowserConfigSearchRuntimeDependencies = {
  createKernel: createKernelRecoverySession,
  createSteel: createSteelRecoverySession,
  releaseKernel: releaseKernelRemoteSession,
  releaseSteel: releaseSteelRemoteSession,
  probe: probeCandidateBrowser,
};

export async function searchAndPromoteBrowserConfig(
  input: {
    taskId: string;
    userId?: string;
    targetUrl: string;
    storageState: Record<string, unknown>;
    userAgent?: string;
    /** Failure-driven: blocked third-party URL that triggered this recovery. */
    blockedResourceUrl?: string;
    /**
     * Sticky hard filter from the agent after a prior payment-CDN failure on
     * this task. When true (or when blockedResourceUrl is a payment CDN), only
     * paymentCdnOk candidates are eligible.
     */
    requirePaymentCdn?: boolean;
  },
  dependencies: BrowserConfigSearchRuntimeDependencies = browserConfigSearchRuntimeDependencies
) {
  const current = await prisma.browserSession.findFirst({
    where: {
      id: input.taskId,
      ...(input.userId === undefined ? {} : { context: { userId: input.userId } }),
    },
    include: { context: true },
  });
  if (current === null) throw new Error(`Browser task not found: ${input.taskId}`);
  const agent = await prisma.agent.findUnique({
    where: { id: current.agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  const proxyLocation: ProxyGeoLocation = agent?.proxyCountry
    ? {
        country: agent.proxyCountry,
        ...(agent.proxyState ? { state: agent.proxyState } : {}),
        ...(agent.proxyCity ? { city: agent.proxyCity } : {}),
      }
    : DEFAULT_GEOLOCATION;
  const configs = browserRecoveryCandidates(proxyLocation);
  const avoidConfigKey = recoveryConfigKeyForSession(current.provider, current.proxyTier);
  if (avoidConfigKey) {
    log.info('Challenge recovery will deprioritize current failing exit', {
      taskId: input.taskId,
      avoidConfigKey,
      provider: current.provider,
      proxyTier: current.proxyTier,
    });
  }
  // Hard filter from the failure that triggered recovery (or sticky agent flag).
  // Never from target URL heuristics — that false-negatives non-Stripe /cart.
  const requirePaymentCdn =
    Boolean(input.requirePaymentCdn) ||
    blockedResourceRequiresPaymentCdn(input.blockedResourceUrl);
  if (requirePaymentCdn) {
    log.info('Challenge recovery requiring payment CDN / Stripe.js hard filter', {
      taskId: input.taskId,
      blockedResourceUrl: input.blockedResourceUrl ?? null,
      stickyRequirePaymentCdn: Boolean(input.requirePaymentCdn),
    });
  }

  const winner = await runParallelBrowserConfigSearch(
    configs,
    {
    create: async (config) => {
      if (config.provider === 'kernel') {
        const session = await dependencies.createKernel(current.agentId, proxyLocation, {
          type: config.kernelProxyType ?? 'residential',
          specificity: config.kernelSpecificity ?? bestSpecificity(proxyLocation),
        });
        return { provider: 'kernel', ...session };
      }
      const session = await dependencies.createSteel({
        proxyLocation,
        proxyMode: config.steelProxyMode ?? 'managed',
        userAgent: input.userAgent,
      });
      return { provider: 'steel', ...session };
    },
    probe: async (config, session) =>
      dependencies.probe(session, input.targetUrl, input.storageState, {
        configKey: config.key,
        provider: config.provider,
        proxyMode: config.proxyMode,
      }),
    promote: async ({ config, session }) => {
      const updated = await prisma.$transaction(async (tx) => {
        const replaced = await tx.browserSession.updateMany({
          where: { id: current.id, sessionId: current.sessionId },
          data: {
            sessionId: session.sessionId,
            debugUrl: session.debugUrl,
            wsUrl: session.wsUrl,
            currentUrl: input.targetUrl,
            status: 'ACTIVE',
            closedAt: null,
            provider: config.provider,
            providerProfileId: session.profileId,
            providerProfileSource: session.profileSource,
            providerProfilePersist: false,
            proxyTier: config.proxyMode,
          },
        });
        if (replaced.count !== 1) return false;
        await tx.browserContext.update({
          where: { id: current.contextId },
          data: {
            preferredBrowserConfig: buildPreferredBrowserConfig(
              config,
              proxyLocation
            ) as unknown as Prisma.InputJsonValue,
          },
        });
        return true;
      });
      if (!updated) throw new Error(`Browser task ${input.taskId} changed during config search`);
      if (current.provider === 'kernel') {
        await dependencies.releaseKernel(current.sessionId).catch(() => {});
      } else {
        await dependencies.releaseSteel(current.sessionId).catch(() => {});
      }
    },
    release: async (_config, session) => {
      if (session.provider === 'kernel') await dependencies.releaseKernel(session.sessionId);
      else await dependencies.releaseSteel(session.sessionId);
    },
    },
    {
      avoidConfigKey,
      requirePaymentCdn,
    }
  );

  return {
    task_id: current.id,
    session_id: winner.session.sessionId,
    debug_url: winner.session.debugUrl,
    ws_url: winner.session.wsUrl,
    saved_url: input.targetUrl,
    provider: winner.config.provider,
    proxy_tier: winner.config.proxyMode,
    config_key: winner.config.key,
    storage_state_preloaded: true,
    recovery_action:
      winner.config.provider === current.provider ? 'config_selected' : 'provider_switched',
    recovery_message: winner.probe.paymentCdnOk
      ? `Selected stable ${winner.config.key} browser configuration after ${winner.probe.attempts} clean probes (payment CDN reachable).`
      : `Selected stable ${winner.config.key} browser configuration after ${winner.probe.attempts} clean probes.`,
    browser_session_metadata: {
      provider: winner.config.provider,
      proxy_source: winner.session.proxySource,
      proxy_location: winner.session.proxyLocation,
      proxy_tier: winner.config.proxyMode,
      config_key: winner.config.key,
      profile_id: null,
      profile_source: winner.session.profileSource,
    },
  };
}
