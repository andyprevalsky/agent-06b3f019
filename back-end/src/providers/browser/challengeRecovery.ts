import type { Prisma } from '@prisma/client';
import type { Browser, Cookie, Page, Response } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createSteelRecoverySession, releaseSteelRemoteSession } from '../steel/session';
import {
  createKernelRecoverySession,
  releaseKernelRemoteSession,
  type KernelRecoveryProxySpecificity,
} from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { BrowserProviderName } from './types';

export interface BrowserRecoveryConfig {
  key: string;
  provider: BrowserProviderName;
  proxyMode: string;
  kernelProxyType?: KernelProxyType;
  kernelSpecificity?: KernelRecoveryProxySpecificity;
  /** Create the Kernel session without a managed/shared proxy exit. */
  omitManagedProxy?: boolean;
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
  'performing security verification',
  'please verify you are a human',
  'sorry, you have been blocked',
  "this site can't be reached",
  'too many requests',
  'unusual traffic from your computer network',
  'verify you are human',
  // Kernel proxy hard-blocks (e.g. checkout.stripe.com → provider_blacklisted).
  // These 502 error pages are not Cloudflare walls, so without these markers a
  // Kernel candidate "passes" the probe and recovery falsely reports success.
  'provider_blacklisted',
  'x-kernel-proxy-error',
  'kernel-proxy-error',
];

/** Hosts Kernel's shared proxy is known to hard-blacklist (502 provider_blacklisted). */
const KERNEL_PROVIDER_BLACKLISTED_HOST_SUFFIXES = [
  'checkout.stripe.com',
  'pay.stripe.com',
] as const;

/**
 * Prefer Steel candidates first when the target host is on Kernel's hard
 * blacklist. Rotating Kernel residential/ISP exits cannot clear a domain
 * denylist — probing Kernel first only burns recovery budget.
 */
export function shouldPreferSteelForChallengeTarget(targetUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return KERNEL_PROVIDER_BLACKLISTED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

function bestSpecificity(location: ProxyGeoLocation): KernelRecoveryProxySpecificity {
  if (location.city) return 'city';
  if (location.state) return 'state';
  return 'country';
}

/** The six independent browser/IP configurations searched after cookie isolation. */
export function browserRecoveryCandidates(
  location: ProxyGeoLocation,
  options?: { preferSteel?: boolean }
): BrowserRecoveryConfig[] {
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
  if (!options?.preferSteel) return candidates;
  // Kernel's managed proxy hard-blacklists Stripe Checkout. Prefer a direct
  // (no managed proxy) Kernel session first, then Steel — never burn budget on
  // residential/ISP/mobile Kernel exits that cannot reach the host.
  const directKernel: BrowserRecoveryConfig = {
    key: 'kernel_direct',
    provider: 'kernel',
    proxyMode: 'none',
    omitManagedProxy: true,
  };
  return [
    directKernel,
    ...candidates.filter((candidate) => candidate.provider === 'steel'),
    ...candidates.filter((candidate) => candidate.provider !== 'steel'),
  ];
}

function candidateScore(candidate: SuccessfulRecoveryCandidate): [number, number] {
  return [-candidate.probe.stablePasses, candidate.probe.latencyMs];
}

/** Create/probe all candidates concurrently, then atomically promote one winner. */
export async function runParallelBrowserConfigSearch(
  configs: BrowserRecoveryConfig[],
  dependencies: ConfigSearchDependencies
): Promise<SuccessfulRecoveryCandidate> {
  const attempts = await Promise.allSettled(
    configs.map(async (config) => {
      const session = await dependencies.create(config);
      try {
        const probe = await dependencies.probe(config, session);
        return { config, session, probe };
      } catch (error) {
        await dependencies.release(config, session).catch(() => {});
        throw error;
      }
    })
  );
  const successful = attempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []
  );
  const stable = successful
    .filter((candidate) => candidate.probe.stablePasses === candidate.probe.attempts)
    .sort((left, right) => {
      const [leftPasses, leftLatency] = candidateScore(left);
      const [rightPasses, rightLatency] = candidateScore(right);
      return leftPasses - rightPasses || leftLatency - rightLatency;
    });
  const winner = stable[0];
  if (winner === undefined) {
    await Promise.allSettled(
      successful.map((candidate) => dependencies.release(candidate.config, candidate.session))
    );
    throw new Error('No stable browser configuration cleared the challenge');
  }

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

export function pageLooksChallenged(input: {
  status: number | null;
  title: string;
  bodyText: string;
  html: string;
}): boolean {
  // 502: Kernel (and similar) proxy denials surface as Bad Gateway. Treating them
  // as challenged keeps a blacklisted Kernel exit from winning the config search.
  if (input.status === 403 || input.status === 429 || input.status === 502) return true;
  const content = `${input.title}\n${input.bodyText}`.toLowerCase();
  if (CHALLENGE_TEXT.some((marker) => content.includes(marker))) return true;
  const html = input.html.toLowerCase();
  if (CHALLENGE_TEXT.some((marker) => html.includes(marker))) return true;
  const visibleMarkup = html.replace(/<[^>]+>/g, '').trim();
  if (!input.title.trim() && !input.bodyText.trim() && !visibleMarkup) return true;
  return (
    html.includes('/cdn-cgi/challenge-platform') ||
    html.includes('cf-chl-') ||
    html.includes('challenges.cloudflare.com/turnstile')
  );
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

async function waitForProviderSolver(page: Page, response: Response | null): Promise<boolean> {
  // Both candidate factories explicitly enable their provider-native solver.
  // Give it the first chance on every attempt, polling the page instead of
  // assuming a fixed solve duration. A clean page exits immediately.
  const deadline = Date.now() + 45_000;
  let currentResponse = response;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    if (!pageLooksChallenged(await challengeSnapshot(page, currentResponse))) return true;
    currentResponse = null;
  }
  return false;
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

export async function probeCandidateBrowser(
  session: RecoveryCandidateSession,
  targetUrl: string,
  storageState: Record<string, unknown>
): Promise<CandidateProbeResult> {
  const started = Date.now();
  let stablePasses = 0;
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
      if (!(await waitForProviderSolver(page, response))) break;
      stablePasses += 1;
    }
  } finally {
    // Closing this CDP client leaves the remote default context (including any
    // solver-refreshed challenge cookies) alive for atomic promotion.
    await session.validationBrowser.close().catch(() => {});
  }
  return { stablePasses, attempts, latencyMs: Date.now() - started };
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
  const configs = browserRecoveryCandidates(proxyLocation, {
    preferSteel: shouldPreferSteelForChallengeTarget(input.targetUrl),
  });

  const winner = await runParallelBrowserConfigSearch(configs, {
    create: async (config) => {
      if (config.provider === 'kernel') {
        const session = config.omitManagedProxy
          ? await dependencies.createKernel(current.agentId, proxyLocation, {
              omitManagedProxy: true,
            })
          : await dependencies.createKernel(current.agentId, proxyLocation, {
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
    probe: async (_config, session) =>
      dependencies.probe(session, input.targetUrl, input.storageState),
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
  });

  return {
    task_id: current.id,
    session_id: winner.session.sessionId,
    debug_url: winner.session.debugUrl,
    ws_url: winner.session.wsUrl,
    saved_url: input.targetUrl,
    provider: winner.config.provider,
    proxy_tier: winner.config.proxyMode,
    storage_state_preloaded: true,
    recovery_action:
      winner.config.provider === current.provider ? 'config_selected' : 'provider_switched',
    recovery_message: `Selected stable ${winner.config.key} browser configuration after ${winner.probe.attempts} clean probes.`,
    browser_session_metadata: {
      provider: winner.config.provider,
      proxy_source: winner.session.proxySource,
      proxy_location: winner.session.proxyLocation,
      profile_id: null,
      profile_source: winner.session.profileSource,
    },
  };
}
