import type { Browser, Cookie } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { releaseSteelRemoteSession } from '../steel/session';
import { createSteelRecoverySession } from '../steel/sessionRecovery';
import { waitForProviderSolver } from './challengePageDetect';
import { applyFingerprintInjection, type FingerprintInjectionData } from './fingerprintInjection';
import {
  selectNetworkEntriesForClassifier,
  type ChallengeClassifierBilling,
  type ChallengeClassifierLlmUsage,
  type NetworkSummaryEntry,
} from './challengeLlmClassifier';
import { createKernelRecoverySession, releaseKernelRemoteSession } from './kernel';
import { recoveryOriginStorageScript } from './recoveryOriginStorage';
import {
  raceProbeAbort,
  sameSiteNavigationUrl,
} from './challengeRecoveryShared';
import type { BrowserProviderName } from './types';

export { recoveryConfigKeyForSession, sameSiteNavigationUrl } from './challengeRecoveryShared';

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
  applyConfigBlacklist,
  orderConfigsForLane,
  runLaneConfigSearch,
  runParallelBrowserConfigSearch,
  type ConfigSearchDependencies,
  type LaneConfigSearchOptions,
} from './challengeRecoveryLaneSearch';
import { closeValidationBrowser } from './challengeRecoverySupport';

export {
  buildPreferredBrowserConfig,
  compatiblePreferredBrowserConfig,
  type PreferredBrowserConfig,
} from './challengeRecoverySupport';

export {
  applyConfigBlacklist,
  orderConfigsForLane,
  runLaneConfigSearch,
  runParallelBrowserConfigSearch,
  type ConfigSearchDependencies,
  type LaneConfigSearchOptions,
};

const log = createLogger('BrowserChallengeRecovery');

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
  /** LLM classifier challenged=true on the final settle pass. */
  classifierChallenged?: boolean;
  /** One-sentence LLM classifier reason for the final settle pass. */
  classifierReason?: string;
  /** Raw network rows captured during navigation (before cap/pinning). */
  networkEntriesCaptured?: number;
  /** Rows passed into the classifier after cited-URL pinning + cap. */
  classifierNetworkEntriesSelected?: number;
  /** Whether js.stripe.com (or cited blocked host) appears in classifier network input. */
  stripeInClassifierNetwork?: boolean;
  /** Final same-site URL after the last clean probe settle (soft-redirect resume). */
  settledUrl?: string;
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
    /** Agent fingerprint applied before navigation so classify matches live identity. */
    fingerprintInjection?: FingerprintInjectionData | null;
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
  const recoveryReason = (logContext.recoveryReason || '').trim() || null;
  // requirePaymentCdn / blockedResourceUrl ignored — LLM reason is sole classifier constraint.
  void logContext.requirePaymentCdn;
  void logContext.blockedResourceUrl;
  const solve = logContext.waitForSolver ?? waitForProviderSolver;
  let settledUrl: string | undefined;
  let classifierChallenged: boolean | undefined;
  let classifierReason: string | undefined;
  let networkEntriesCaptured = 0;
  let classifierNetworkEntriesSelected = 0;
  let stripeInClassifierNetwork = false;
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
      await raceProbeAbort(
        context.addInitScript(recoveryOriginStorageScript(storageState)),
        signal
      );
    }
    const page = context.pages()[0] ?? (await raceProbeAbort(context.newPage(), signal));
    if (signal?.aborted) {
      throw new Error('lane_aborted');
    }
    // Identity BEFORE navigation — classify must see the same fingerprint the
    // agent re-attaches on CDP reconnect after promote.
    await raceProbeAbort(applyFingerprintInjection(page, logContext.fingerprintInjection), signal);
    // Tool-parity classifier inputs: accumulate network like BrowserNetworkRecorder
    // / read_network_requests (status + truncated bodies), not perf timings alone.
    const networkEntries: NetworkSummaryEntry[] = [];
    const pendingResponses = new Set<Promise<void>>();
    const onResponse = async (res: import('playwright').Response) => {
      const task = (async () => {
        try {
          const req = res.request();
          const url = req.url();
          if (!url.startsWith('http')) return;
          let body: string | undefined;
          let truncated = false;
          try {
            const resourceType = req.resourceType();
            if (['xhr', 'fetch', 'document', 'script'].includes(resourceType)) {
              const raw = await res.text();
              if (raw) {
                body = raw.slice(0, 200);
                truncated = raw.length > 200;
              }
            }
          } catch {
            /* opaque / binary */
          }
          networkEntries.push({
            url: url.slice(0, 180),
            status: res.status(),
            statusText: res.statusText(),
            ...(body !== undefined
              ? { response_body: body, response_body_truncated: truncated }
              : {}),
          });
        } catch {
          /* ignore listener errors */
        }
      })();
      pendingResponses.add(task);
      try {
        await task;
      } finally {
        pendingResponses.delete(task);
      }
    };
    if (typeof (page as { on?: unknown }).on === 'function') {
      page.on('response', onResponse);
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
    // Prefer the same stripped visible text the agent DOM tool feeds the
    // classifier (iframe titles/names kept; scripts stripped).
    let agentDomTree: string | null = null;
    try {
      // String form avoids DOM lib types in the Node tsc project (same pattern as
      // challengeLlmClassifier.captureCleanedDom).
      const cleaned = await page.evaluate(
        `(() => {
          const body = document.body;
          if (!body) return '';
          const clone = body.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, svg').forEach((n) => n.remove());
          clone.querySelectorAll('iframe').forEach((frame) => {
            const marker = document.createElement('div');
            marker.textContent = '[iframe title=' + JSON.stringify(frame.title || '') +
              ' src=' + JSON.stringify(frame.src || '') + ']';
            frame.replaceWith(marker);
          });
          return (clone.innerText || clone.textContent || '')
            .replace(/\\s+/g, ' ')
            .trim()
            .slice(0, 12000);
        })()`
      );
      agentDomTree = typeof cleaned === 'string' ? cleaned : null;
    } catch {
      agentDomTree = null;
    }
    if (pendingResponses.size > 0) {
      await raceProbeAbort(Promise.allSettled([...pendingResponses]), signal);
    }
    const classifierNetworkEntries = selectNetworkEntriesForClassifier(networkEntries, {
      recoveryReason,
    });
    networkEntriesCaptured = networkEntries.length;
    classifierNetworkEntriesSelected = classifierNetworkEntries.length;
    stripeInClassifierNetwork = classifierNetworkEntries.some((entry) =>
      String(entry.url || entry.name || '')
        .toLowerCase()
        .includes('js.stripe.com')
    );
    const attempt = await raceProbeAbort(
      solve(page, response, billing, {
        recoveryReason,
        agentDomTree,
        networkEntries: classifierNetworkEntries,
      }),
      signal
    );
    if (typeof (page as { off?: unknown }).off === 'function') {
      page.off('response', onResponse);
    }
    if (attempt.usage) classifierLlmUsage.push(attempt.usage);
    classifierChallenged = !attempt.clean;
    classifierReason = attempt.reason ?? undefined;
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
    await closeValidationBrowser(session);
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
    classifierChallenged,
    classifierReason,
    networkEntriesCaptured,
    classifierNetworkEntriesSelected,
    stripeInClassifierNetwork,
    ...(settledUrl ? { settledUrl } : {}),
  };
}

export const browserConfigSearchRuntimeDependencies: BrowserConfigSearchRuntimeDependencies = {
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
export class ChallengeConfigSearchExhaustedError extends Error {
  readonly failedConfigKeys: string[];

  constructor(message: string, failedConfigKeys: string[]) {
    super(message);
    this.name = 'ChallengeConfigSearchExhaustedError';
    this.failedConfigKeys = [...failedConfigKeys];
  }
}

export async function probeCookieVariant(
  input: {
    taskId: string;
    userId?: string;
    targetUrl: string;
    storageState: Record<string, unknown>;
    userAgent?: string;
    blockedResourceUrl?: string;
    recoveryReason?: string | null;
    /** Skip configs that already failed for this agent until catalog exhaust. */
    blockedConfigKeys?: string[];
    /** Optional override; defaults to the task owner's stored fingerprint (config-search parity). */
    fingerprintInjection?: FingerprintInjectionData | null;
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
  const fingerprintInjection =
    input.fingerprintInjection !== undefined
      ? input.fingerprintInjection
      : billing.userId
        ? await import('../steel/files').then((mod) =>
            mod.getFingerprintInjectionData(billing.userId!)
          )
        : null;
  const configs = browserRecoveryCandidates(proxyLocation, { preferSteel });
  const cookieBlacklist = applyConfigBlacklist(configs, input.blockedConfigKeys);
  const config = cookieBlacklist.configs[0];
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
        fingerprintInjection,
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
      agentId: billing.agentId,
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

export { searchAndPromoteBrowserConfig } from './challengeRecoveryPromote';
