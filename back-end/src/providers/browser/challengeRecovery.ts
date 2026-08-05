import type { Prisma } from '@prisma/client';
import type { Browser, Cookie, Page, Response } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { createSteelRecoverySession, releaseSteelRemoteSession } from '../steel/session';
import {
  createKernelRecoverySession,
  releaseKernelRemoteSession,
  type KernelRecoveryProxySpecificity,
} from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { BrowserProviderName } from './types';

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
  /** True when the candidate can fetch js.stripe.com AND api.stripe.com (Elements). */
  paymentCdnOk: boolean;
  /** Per-host tunnel reachability from the candidate page (for ranking + logs). */
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

const CHALLENGE_TEXT = [
  'access denied',
  'attention required! | cloudflare',
  'checking your browser',
  'enable javascript and cookies to continue',
  'just a moment',
  'performing security verification',
  'please verify you are a human',
  'sorry, you have been blocked',
  "this site can't be reached",
  'too many requests',
  'unusual traffic from your computer network',
  'verify you are human',
];
// Present on hard CF walls *and* on cleared pages that embed Bot Management /
// Turnstile (Eventim ticket HTML). Only count when visible body is still sparse.
const HTML_CHALLENGE_MARKERS = [
  '/cdn-cgi/challenge-platform',
  'cf-chl-',
  'challenges.cloudflare.com/turnstile',
];
const SUBSTANTIVE_BODY_CHARS = 80;

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

function paymentHostsOkCount(probe: CandidateProbeResult): number {
  const hosts = probe.paymentCdnHosts;
  if (!hosts) return probe.paymentCdnOk ? 2 : 0;
  return Object.values(hosts).filter(Boolean).length;
}

function candidateScore(
  candidate: SuccessfulRecoveryCandidate,
  avoidConfigKey?: string
): [number, number, number, number, number, number] {
  // Prefer CF-stable, then full payment-CDN reachability (js+api.stripe.com),
  // then partial host clears, then avoid the currently-failing exit. When we
  // are rotating off a known-bad exit and nobody cleared Stripe, prefer Steel
  // managed (historical payment-tunnel winner) before raw probe latency.
  const rotatingOffFailedExit = Boolean(avoidConfigKey);
  return [
    -candidate.probe.stablePasses,
    candidate.probe.paymentCdnOk ? 0 : 1,
    -paymentHostsOkCount(candidate.probe),
    avoidConfigKey && candidate.config.key === avoidConfigKey ? 1 : 0,
    rotatingOffFailedExit &&
    !candidate.probe.paymentCdnOk &&
    candidate.config.key === 'steel_managed'
      ? 0
      : 1,
    candidate.probe.latencyMs,
  ];
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
}

/** Create/probe all candidates concurrently, then atomically promote one winner. */
export async function runParallelBrowserConfigSearch(
  configs: BrowserRecoveryConfig[],
  dependencies: ConfigSearchDependencies,
  options: ParallelConfigSearchOptions = {}
): Promise<SuccessfulRecoveryCandidate> {
  const avoidConfigKey = options.avoidConfigKey;
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
  // navigation verify remains the hard gate before recovery success.
  const winner =
    ranked.find((candidate) => candidate.probe.stablePasses === candidate.probe.attempts) ??
    ranked[0];
  if (winner === undefined) {
    log.error('Challenge recovery found no stable browser configuration', {
      candidateCount: configs.length,
      successfulProbeCount: successful.length,
      configKeys: configs.map((config) => config.key),
    });
    await Promise.allSettled(
      successful.map((candidate) => dependencies.release(candidate.config, candidate.session))
    );
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

export function challengeDetectionReason(input: {
  status: number | null;
  title: string;
  bodyText: string;
  html: string;
}): string | null {
  if (input.status === 403 || input.status === 429) return `status_${input.status}`;
  const content = `${input.title}\n${input.bodyText}`.toLowerCase();
  for (const marker of CHALLENGE_TEXT) {
    if (content.includes(marker)) return `text:${marker}`;
  }
  const html = input.html.toLowerCase();
  const visibleMarkup = html.replace(/<[^>]+>/g, '').trim();
  if (!input.title.trim() && !input.bodyText.trim() && !visibleMarkup) return 'empty_page';
  // Cleared Eventim pages embed challenge-platform/Turnstile beside real
  // inventory copy — do not treat those script URLs as a wall once body text
  // is substantive.
  if (input.bodyText.trim().length < SUBSTANTIVE_BODY_CHARS) {
    for (const marker of HTML_CHALLENGE_MARKERS) {
      if (html.includes(marker)) return `html:${marker}`;
    }
  }
  return null;
}

export function pageLooksChallenged(input: {
  status: number | null;
  title: string;
  bodyText: string;
  html: string;
}): boolean {
  return challengeDetectionReason(input) !== null;
}

async function challengeSnapshot(page: Page, response: Response | null) {
  const [title, bodyText, html] = await Promise.all([
    page.title().catch(() => ''),
    page
      .locator('body')
      .innerText({ timeout: 2_000 })
      .catch(() => ''),
    page.content().catch(() => ''),
  ]);
  return {
    status: response?.status() ?? null,
    title: title.slice(0, 1_000),
    bodyText: bodyText.slice(0, 20_000),
    html: html.slice(0, 100_000),
  };
}

async function waitForProviderSolver(
  page: Page,
  response: Response | null
): Promise<{ clean: boolean; reason: string | null; title: string }> {
  // Both candidate factories explicitly enable their provider-native solver.
  // Give it the first chance on every attempt, polling the page instead of
  // assuming a fixed solve duration. A clean page exits immediately.
  const deadline = Date.now() + 45_000;
  let currentResponse = response;
  let lastReason: string | null = 'probe_timeout';
  let lastTitle = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const snapshot = await challengeSnapshot(page, currentResponse);
    lastTitle = snapshot.title;
    lastReason = challengeDetectionReason(snapshot);
    if (lastReason === null) return { clean: true, reason: null, title: lastTitle };
    currentResponse = null;
  }
  return { clean: false, reason: lastReason, title: lastTitle };
}

function recoveryOriginStorageScript(storageState: Record<string, unknown>): string {
  const origins = Array.isArray(storageState.origins) ? storageState.origins : [];
  return `
(() => {
  const originStates = ${JSON.stringify(origins).replaceAll('</', '<\\/')};
  const completionKey = '__naviRecoveryStorageRestoredV1';
  let restorePromise;
  const restoreCurrentOrigin = async () => {
    const state = originStates.find((entry) => entry.origin === location.origin);
    if (!state) return;
    try { if (sessionStorage.getItem(completionKey) === '1') return; } catch {}
    localStorage.clear();
    for (const item of state.localStorage || []) localStorage.setItem(item.name, item.value);
    for (const database of state.indexedDB || []) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(database.name, database.version);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of database.stores || []) {
            if (!db.objectStoreNames.contains(store.name)) {
              db.createObjectStore(store.name, {
                keyPath: store.keyPath === undefined ? null : store.keyPath,
                autoIncrement: Boolean(store.autoIncrement),
              });
            }
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const storeNames = (database.stores || [])
            .map((store) => store.name)
            .filter((name) => db.objectStoreNames.contains(name));
          if (storeNames.length === 0) { db.close(); resolve(); return; }
          const transaction = db.transaction(storeNames, 'readwrite');
          for (const storeState of database.stores || []) {
            if (!storeNames.includes(storeState.name)) continue;
            const store = transaction.objectStore(storeState.name);
            store.clear();
            for (const record of storeState.records || []) {
              if (store.keyPath === null && Object.hasOwn(record, 'key')) {
                store.put(record.value, record.key);
              } else {
                store.put(record.value);
              }
            }
          }
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
    }
    try { sessionStorage.setItem(completionKey, '1'); } catch {}
  };
  globalThis.__naviRestoreRecoveryStorage = () => {
    restorePromise ||= restoreCurrentOrigin();
    return restorePromise;
  };
  void globalThis.__naviRestoreRecoveryStorage().catch(() => undefined);
})();`;
}

async function probePaymentCdnReachable(
  page: Page
): Promise<{ paymentCdnOk: boolean; paymentCdnHosts: Record<string, boolean> }> {
  // Run inside the candidate page so the fetch uses the same proxy tunnel the
  // checkout card fields will need. js.stripe.com alone is insufficient —
  // Eventim Elements stay empty when api.stripe.com tunnels fail after a
  // js-only paymentCdnOk promote (agent baf33041-…). Record per-host results so
  // ranking can prefer partial clears and logs show which host failed.
  const paymentCdnHosts = await page
    .evaluate(async () => {
      const targets: Array<{ host: string; url: string }> = [
        { host: 'js.stripe.com', url: 'https://js.stripe.com/v3/' },
        { host: 'api.stripe.com', url: 'https://api.stripe.com/healthcheck' },
      ];
      const hosts: Record<string, boolean> = {};
      for (const target of targets) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          await fetch(target.url, {
            method: 'GET',
            signal: controller.signal,
            credentials: 'omit',
          });
          clearTimeout(timer);
          // Any HTTP response means the proxy tunnel reached the host.
          // Stripe may return 401/404 on probe paths; treating only
          // response.ok as success false-negatives reachable tunnels and
          // leaves Elements empty after a CF-only promote.
          hosts[target.host] = true;
        } catch {
          hosts[target.host] = false;
        }
      }
      return hosts;
    })
    .catch(() => ({
      'js.stripe.com': false,
      'api.stripe.com': false,
    }));
  const paymentCdnOk = Boolean(
    paymentCdnHosts['js.stripe.com'] && paymentCdnHosts['api.stripe.com']
  );
  return { paymentCdnOk, paymentCdnHosts };
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
    { avoidConfigKey }
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
    recovery_message: `Selected stable ${winner.config.key} browser configuration after ${winner.probe.attempts} clean probes.`,
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
