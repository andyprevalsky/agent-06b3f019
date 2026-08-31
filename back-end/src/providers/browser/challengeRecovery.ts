import type { Prisma } from '@prisma/client';
import type { Browser, Cookie } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { releaseSteelRemoteSession } from '../steel/session';
import { createSteelRecoverySession } from '../steel/sessionRecovery';
import { waitForProviderSolver } from './challengePageDetect';
import type {
  ChallengeClassifierBilling,
  ChallengeClassifierLlmUsage,
} from './challengeLlmClassifier';
import {
  createKernelRecoverySession,
  releaseKernelRemoteSession,
  type KernelRecoveryProxySpecificity,
} from './kernel';
import type { KernelProxyType } from './kernelProxy';
import { recoveryOriginStorageScript } from './recoveryOriginStorage';
import type { BrowserProviderName } from './types';

export {
  bestSpecificity,
  browserRecoveryCandidates,
  paymentCdnFocusedCandidates,
  recoverySearchPlan,
  shouldPreferSteelForChallengeTarget,
  type BrowserRecoveryConfig,
} from './challengeRecoveryCandidates';
import {
  bestSpecificity,
  browserRecoveryCandidates,
  shouldPreferSteelForChallengeTarget,
  type BrowserRecoveryConfig,
} from './challengeRecoveryCandidates';

export {
  challengeDetectionReason,
  isUsableDocumentTitle,
  pageLooksChallenged,
  PROVIDER_SOLVER_WAIT_MS,
} from './challengePageDetect';
export {
  classifyChallengeWithLlm,
  classifyPageAfterSettle,
  CHALLENGE_LLM_MODEL,
  type ChallengeClassifierBilling,
  type ChallengeClassifierLlmUsage,
} from './challengeLlmClassifier';
export {
  blockedResourceRequiresPaymentCdn,
  targetLooksLikePaymentDocument,
} from './paymentCdnProbe';
import {
  orderConfigsForLane,
  runLaneConfigSearch,
  runParallelBrowserConfigSearch,
  type ConfigSearchDependencies,
  type LaneConfigSearchOptions,
} from './challengeRecoveryLaneSearch';

export {
  orderConfigsForLane,
  runLaneConfigSearch,
  runParallelBrowserConfigSearch,
  type ConfigSearchDependencies,
  type LaneConfigSearchOptions,
};

const log = createLogger('BrowserChallengeRecovery');

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

/** Close the Playwright validation CDP client without failing remote release. */
async function closeValidationBrowser(session: RecoveryCandidateSession): Promise<void> {
  await session.validationBrowser.close().catch(() => {});
}

export interface CandidateProbeResult {
  stablePasses: number;
  attempts: number;
  latencyMs: number;
  /**
   * True when the candidate can reach the blocked third-party resource that
   * triggered recovery (fetch + script-load when script-shaped).
   */
  paymentCdnOk: boolean;
  /** Per-host / probe-step reachability results (for ranking + logs). */
  paymentCdnHosts?: Record<string, boolean>;
  /**
   * rose-1-mini classifier usage rows from this probe (forwarded into the
   * agent ToolUsage ledger via recover-challenge → usage_by_model).
   */
  classifierLlmUsage?: ChallengeClassifierLlmUsage[];
  /** Final same-site URL after the last clean probe settle (soft-redirect resume). */
  settledUrl?: string;
}

function registrableHost(hostname: string | null | undefined): string {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Same-site settled URL for follow-up probe / resume navigations. */
export function sameSiteNavigationUrl(
  targetUrl: string,
  settledUrl: string | null | undefined
): string | null {
  const settled = String(settledUrl || '').trim();
  if (!settled.startsWith('http://') && !settled.startsWith('https://')) return null;
  let targetHost = '';
  let settledHost = '';
  try {
    targetHost = registrableHost(new URL(targetUrl).hostname);
    settledHost = registrableHost(new URL(settled).hostname);
  } catch {
    return null;
  }
  if (!targetHost || !settledHost || targetHost !== settledHost) return null;
  return settled;
}

export interface SuccessfulRecoveryCandidate {
  config: BrowserRecoveryConfig;
  session: RecoveryCandidateSession;
  probe: CandidateProbeResult;
}

export interface BrowserConfigSearchRuntimeDependencies {
  createKernel: typeof createKernelRecoverySession;
  createSteel: typeof createSteelRecoverySession;
  releaseKernel: typeof releaseKernelRemoteSession;
  releaseSteel: typeof releaseSteelRemoteSession;
  probe: typeof probeCandidateBrowser;
}

export interface RecoveryStorageLane {
  key: string;
  storageState: Record<string, unknown>;
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
    if (tier === 'none') return 'kernel_direct';
    if (tier.startsWith('isp')) return 'kernel_isp';
    if (tier.startsWith('mobile')) return 'kernel_mobile';
    if (tier.includes('residential_state') || tier === 'residential_state') {
      return 'kernel_residential_state';
    }
    if (tier.includes('residential_city') || tier === 'residential_city') {
      return 'kernel_residential_city';
    }
    if (tier.includes('residential_country') || tier === 'residential_country') {
      return 'kernel_residential_country';
    }
    if (tier.startsWith('residential')) return 'kernel_residential_city';
  }
  return undefined;
}

/** Reject promptly when a sibling lane claims the winner mid-probe. */
async function raceProbeAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new Error('lane_aborted');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('lane_aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export async function probeCandidateBrowser(
  session: RecoveryCandidateSession,
  targetUrl: string,
  storageState: Record<string, unknown>,
  logContext: {
    configKey?: string;
    provider?: string;
    proxyMode?: string;
    laneKey?: string;
    /** Absolute URL of the blocked third-party resource (folded into LLM reason). */
    blockedResourceUrl?: string;
    /** Agent recovery reason forwarded to the LLM classifier. */
    recoveryReason?: string | null;
    /** @deprecated Ignored — promote uses the LLM gate only. */
    requirePaymentCdn?: boolean;
    /** Test-only solver override (avoids live LLM in unit probes). */
    waitForSolver?: typeof waitForProviderSolver;
  } = {},
  billing: ChallengeClassifierBilling = {},
  signal?: AbortSignal
): Promise<CandidateProbeResult> {
  const started = Date.now();
  let stablePasses = 0;
  const classifierLlmUsage: ChallengeClassifierLlmUsage[] = [];
  // One nav + one classify. Soft-redirect re-nav / dual stablePasses were scar
  // tissue; resume at whatever URL the single settle lands on.
  const attempts = 1;
  const blockedResourceUrl = (logContext.blockedResourceUrl || '').trim();
  const recoveryReasonParts = [
    (logContext.recoveryReason || '').trim(),
    blockedResourceUrl
      ? `Blocked third-party resource that must become reachable/usable: ${blockedResourceUrl}`
      : '',
  ].filter(Boolean);
  const recoveryReason = recoveryReasonParts.join('\n') || null;
  // requirePaymentCdn ignored — kept on the type for older callers.
  void logContext.requirePaymentCdn;
  const solve = logContext.waitForSolver ?? waitForProviderSolver;
  let settledUrl: string | undefined;
  try {
    if (signal?.aborted) {
      throw new Error('lane_aborted');
    }
    const context = session.validationBrowser.contexts()[0];
    if (context === undefined) {
      throw new Error(`Recovery candidate ${session.sessionId} has no default browser context`);
    }
    const cookies = Array.isArray(storageState.cookies) ? (storageState.cookies as Cookie[]) : [];
    if (cookies.length > 0) await raceProbeAbort(context.addCookies(cookies), signal);
    const origins = Array.isArray(storageState.origins) ? storageState.origins : [];
    if (origins.length > 0) {
      await raceProbeAbort(context.addInitScript(recoveryOriginStorageScript(storageState)), signal);
    }
    const page = context.pages()[0] ?? (await raceProbeAbort(context.newPage(), signal));
    if (signal?.aborted) {
      throw new Error('lane_aborted');
    }
    const response = await raceProbeAbort(
      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null),
      signal
    );
    if (origins.length > 0) {
      await raceProbeAbort(
        page.evaluate(async () => {
          const recoveryGlobal = globalThis as typeof globalThis & {
            __naviRestoreRecoveryStorage?: () => Promise<void>;
          };
          await recoveryGlobal.__naviRestoreRecoveryStorage?.();
        }),
        signal
      );
    }
    const attempt = await raceProbeAbort(
      solve(page, response, billing, { recoveryReason }),
      signal
    );
    if (attempt.usage) classifierLlmUsage.push(attempt.usage);
    if (!attempt.clean) {
      log.info('Challenge recovery candidate probe attempt still challenged', {
        ...logContext,
        attempt: 1,
        attempts,
        reason: attempt.reason,
        title: attempt.title.slice(0, 200),
        actual_model: attempt.usage?.actual_model ?? null,
        prompt_tokens: attempt.usage?.prompt_tokens ?? null,
      });
    } else {
      const pageUrl = sameSiteNavigationUrl(targetUrl, page.url());
      if (pageUrl) {
        settledUrl = pageUrl;
      }
      log.info('Challenge recovery candidate probe attempt clean', {
        ...logContext,
        attempt: 1,
        attempts,
        title: attempt.title.slice(0, 200),
        settledUrl: settledUrl ?? null,
        actual_model: attempt.usage?.actual_model ?? null,
        prompt_tokens: attempt.usage?.prompt_tokens ?? null,
      });
      stablePasses = 1;
    }
  } finally {
    // Closing this CDP client leaves the remote default context (including any
    // solver-refreshed challenge cookies) alive for atomic promotion.
    await session.validationBrowser.close().catch(() => {});
  }
  if (signal?.aborted) {
    throw new Error('lane_aborted');
  }
  return {
    stablePasses,
    attempts,
    latencyMs: Date.now() - started,
    // CDN hard-filter removed; field retained for wire/log compatibility.
    paymentCdnOk: true,
    paymentCdnHosts: {},
    classifierLlmUsage,
    ...(settledUrl ? { settledUrl } : {}),
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

/**
 * Probe one cookie/storage variant on an ephemeral Kernel/Steel session.
 *
 * Used by the agent cookie-probe wave so isolation experiments never open
 * ``new_context`` windows on the live debug desktop.
 */
export async function probeCookieVariant(
  input: {
    taskId: string;
    userId?: string;
    targetUrl: string;
    storageState: Record<string, unknown>;
    userAgent?: string;
    blockedResourceUrl?: string;
    recoveryReason?: string | null;
  },
  dependencies: BrowserConfigSearchRuntimeDependencies = browserConfigSearchRuntimeDependencies
): Promise<{ clean: boolean; configKey: string; latencyMs: number }> {
  const current = await prisma.browserSession.findFirst({
    where: {
      id: input.taskId,
      ...(input.userId === undefined ? {} : { context: { userId: input.userId } }),
    },
    include: { context: true },
  });
  if (current === null) throw new Error(`Browser task not found: ${input.taskId}`);
  const billing: ChallengeClassifierBilling = {
    agentId: current.agentId,
    userId: input.userId ?? current.context.userId,
  };
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
  const preferSteel = shouldPreferSteelForChallengeTarget(input.targetUrl, {
    requirePaymentCdn: false,
  });
  const configs = browserRecoveryCandidates(proxyLocation, { preferSteel });
  const config = configs[0];
  if (!config) {
    throw new Error('No ephemeral browser config available for cookie-variant probe');
  }

  let session: RecoveryCandidateSession | null = null;
  try {
    if (config.provider === 'kernel') {
      const created = config.omitManagedProxy
        ? await dependencies.createKernel(current.agentId, proxyLocation, {
            omitManagedProxy: true,
          })
        : await dependencies.createKernel(current.agentId, proxyLocation, {
            type: config.kernelProxyType ?? 'residential',
            specificity: config.kernelSpecificity ?? bestSpecificity(proxyLocation),
          });
      session = { provider: 'kernel', ...created };
    } else {
      const created = await dependencies.createSteel({
        proxyLocation,
        proxyMode: config.steelProxyMode ?? 'managed',
        userAgent: input.userAgent,
      });
      session = { provider: 'steel', ...created };
    }
    const probe = await dependencies.probe(
      session,
      input.targetUrl,
      input.storageState,
      {
        configKey: config.key,
        provider: config.provider,
        proxyMode: config.proxyMode,
        laneKey: 'cookie_probe',
        blockedResourceUrl: input.blockedResourceUrl,
        recoveryReason: input.recoveryReason,
      },
      billing
    );
    const clean = probe.stablePasses === probe.attempts && probe.attempts > 0;
    log.info('Challenge recovery ephemeral cookie-variant probe', {
      taskId: input.taskId,
      configKey: config.key,
      clean,
      stablePasses: probe.stablePasses,
      attempts: probe.attempts,
      latencyMs: probe.latencyMs,
      agent_id: billing.agentId,
    });
    return { clean, configKey: config.key, latencyMs: probe.latencyMs };
  } finally {
    if (session) {
      if (session.provider === 'kernel') {
        await dependencies.releaseKernel(session.sessionId).catch(() => {});
      } else {
        await dependencies.releaseSteel(session.sessionId).catch(() => {});
      }
    }
  }
}

export async function searchAndPromoteBrowserConfig(
  input: {
    taskId: string;
    userId?: string;
    targetUrl: string;
    storageState: Record<string, unknown>;
    /** Parallel cookie-signature lanes; defaults to a single lane from storageState. */
    storageLanes?: RecoveryStorageLane[];
    userAgent?: string;
    /** Failure-driven: blocked third-party URL that triggered this recovery. */
    blockedResourceUrl?: string;
    /** Agent recover_from_challenge reason for the LLM gate. */
    recoveryReason?: string | null;
    /** @deprecated Ignored — single LLM gate only. */
    requirePaymentCdn?: boolean;
    preserveAuth?: boolean;
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
  const billing: ChallengeClassifierBilling = {
    agentId: current.agentId,
    userId: input.userId ?? current.context.userId,
  };
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
  const sessionAvoidConfigKey = recoveryConfigKeyForSession(current.provider, current.proxyTier);
  // Payment-CDN hard filter removed. blockedResourceUrl is evidence for the LLM gate.
  void input.requirePaymentCdn;
  const preferSteel = shouldPreferSteelForChallengeTarget(input.targetUrl, {
    requirePaymentCdn: false,
  });
  const configs = browserRecoveryCandidates(proxyLocation, { preferSteel });
  const lanes: RecoveryStorageLane[] =
    input.storageLanes && input.storageLanes.length > 0
      ? input.storageLanes
      : [{ key: 'default', storageState: input.storageState }];

  if (sessionAvoidConfigKey) {
    log.info('Challenge recovery will deprioritize current failing exit', {
      taskId: input.taskId,
      avoidConfigKey: sessionAvoidConfigKey,
      provider: current.provider,
      proxyTier: current.proxyTier,
    });
  }
  log.info('Challenge recovery lane search', {
    taskId: input.taskId,
    laneKeys: lanes.map((lane) => lane.key),
    configKeys: configs.map((config) => config.key),
    avoidConfigKey: sessionAvoidConfigKey ?? null,
    preserveAuth: input.preserveAuth ?? null,
    blockedResourceUrl: input.blockedResourceUrl ?? null,
    agent_id: billing.agentId,
  });

  const searchDependencies: ConfigSearchDependencies = {
    create: async (config, signal) => {
      if (signal.aborted) {
        throw new Error('lane_aborted');
      }
      if (config.provider === 'kernel') {
        const session = config.omitManagedProxy
          ? await dependencies.createKernel(current.agentId, proxyLocation, {
              omitManagedProxy: true,
            })
          : await dependencies.createKernel(current.agentId, proxyLocation, {
              type: config.kernelProxyType ?? 'residential',
              specificity: config.kernelSpecificity ?? bestSpecificity(proxyLocation),
            });
        if (signal.aborted) {
          await closeValidationBrowser({ provider: 'kernel', ...session });
          await dependencies.releaseKernel(session.sessionId).catch(() => {});
          throw new Error('lane_aborted');
        }
        return { provider: 'kernel', ...session };
      }
      const session = await dependencies.createSteel({
        proxyLocation,
        proxyMode: config.steelProxyMode ?? 'managed',
        userAgent: input.userAgent,
      });
      if (signal.aborted) {
        await closeValidationBrowser({ provider: 'steel', ...session });
        await dependencies.releaseSteel(session.sessionId).catch(() => {});
        throw new Error('lane_aborted');
      }
      return { provider: 'steel', ...session };
    },
    probe: async (config, session, lane, signal) => {
      if (signal.aborted) {
        throw new Error('lane_aborted');
      }
      return dependencies.probe(
        session,
        input.targetUrl,
        lane.storageState,
        {
          configKey: config.key,
          provider: config.provider,
          proxyMode: config.proxyMode,
          laneKey: lane.key,
          blockedResourceUrl: input.blockedResourceUrl,
          recoveryReason: input.recoveryReason,
        },
        billing,
        signal
      );
    },
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
      await closeValidationBrowser(session);
      if (session.provider === 'kernel') await dependencies.releaseKernel(session.sessionId);
      else await dependencies.releaseSteel(session.sessionId);
    },
  };

  const winner = await runLaneConfigSearch(configs, lanes, searchDependencies, {
    avoidConfigKey: sessionAvoidConfigKey,
  });
  const classifierLlmUsage: ChallengeClassifierLlmUsage[] = [
    ...(winner.probe.classifierLlmUsage ?? []),
  ];

  const resumeUrl =
    sameSiteNavigationUrl(input.targetUrl, winner.probe.settledUrl) ?? input.targetUrl;
  return {
    task_id: current.id,
    session_id: winner.session.sessionId,
    debug_url: winner.session.debugUrl,
    ws_url: winner.session.wsUrl,
    saved_url: resumeUrl,
    provider: winner.config.provider,
    proxy_tier: winner.config.proxyMode,
    config_key: winner.config.key,
    storage_state_preloaded: true,
    recovery_action:
      winner.config.provider === current.provider ? 'config_selected' : 'provider_switched',
    recovery_message: `Selected stable ${winner.config.key} browser configuration after ${winner.probe.attempts} clean probes.`,
    classifier_llm_usage: classifierLlmUsage,
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
