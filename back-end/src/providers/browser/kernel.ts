import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { PermissionDeniedError, RateLimitError } from '@onkernel/sdk';
import type { Browser } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { retryWithBackoff } from '../retry';
import { connectValidatedBrowser, validateSessionConnection } from '../steel/sessionConnection';
import { browserProviderEnabled } from './config';
import { kernelCaptchaTelemetryConfig } from './captchaTelemetry';
import { installCaptchaSolveIndicator } from './captchaSolveIndicator';
import { getProviderProfile, rememberProviderProfile } from './context';
import { persistBrowserSessionRow } from './sessionPersist';
import {
  createSessionOnKernelProxyLadder,
  KERNEL_CREATE_REQUEST_OPTIONS,
  kernelProxyCandidates,
  resolveKernelProxyMode,
  type KernelProxyType,
} from './kernelProxy';
import {
  BrowserProviderRateLimitError,
  type BrowserProviderResumeSession,
  type BrowserProviderSession,
  type BrowserSessionHealth,
} from './types';
import {
  benchmarkIsolatedBrowserProfilesEnabled,
  cleanupBenchmarkKernelProfiles as cleanupIsolatedKernelProfiles,
  getOrCreateBenchmarkKernelProfile,
  markBenchmarkKernelProfileBound,
} from './benchmarkProfileIsolation';
import {
  providerProfileData,
  providerProfileMismatch,
  recordedProviderProfileBinding,
  type ProviderProfileBinding,
} from './profileBinding';
import { kernelTimeoutSeconds, readOnlyLiveView } from './kernelSessionConfig';
import { kernelClient } from './kernelClient';
import {
  captureKernelScreenshot,
  ensureKernelSessionFileDirectories,
  getKernelCaptchaTelemetry,
  listKernelSessionFiles,
  pressKernelKeys,
  readKernelSessionFile,
  resizeKernelViewport,
  uploadKernelSessionFile,
} from './kernelSessionIo';

export {
  captureKernelScreenshot,
  ensureKernelSessionFileDirectories,
  getKernelCaptchaTelemetry,
  listKernelSessionFiles,
  pressKernelKeys,
  readKernelSessionFile,
  resizeKernelViewport,
  uploadKernelSessionFile,
};

const log = createLogger('Kernel');

class KernelSessionValidationError extends Error {}

export async function cleanupBenchmarkKernelProfiles(): Promise<void> {
  await cleanupIsolatedKernelProfiles(kernelClient());
}

/**
 * Kernel profiles persist Chromium's open pages along with cookies and storage.
 * Replace restored pages with one clean bootstrap tab. Kernel destroys the
 * Playwright context when its final page closes, so creating the clean tab
 * first is required for the caller to reuse this validated connection for
 * credential injection.
 */
export async function resetKernelSessionTabs(browser: Browser): Promise<number> {
  const primaryContext = browser.contexts()[0];
  if (primaryContext === undefined) {
    throw new KernelSessionValidationError('Kernel browser has no context after CDP validation');
  }
  const pages = browser.contexts().flatMap((context) => context.pages());
  await primaryContext.newPage();
  await Promise.all(pages.map((page) => page.close({ runBeforeUnload: false })));
  return pages.length;
}

type KernelProxySelection = {
  proxyId?: string;
  proxyKey?: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
};

export type KernelRecoveryProxySpecificity = 'city' | 'state' | 'country';

interface KernelRemoteSessionOptions {
  forceManagedProxyType?: KernelProxyType;
  exactManagedProxy?: {
    type: KernelProxyType;
    specificity: KernelRecoveryProxySpecificity;
  };
  /** Skip managed/shared proxies (used when the target host is provider-blacklisted). */
  omitManagedProxy?: boolean;
  omitProfile?: boolean;
  boundProfile?: ProviderProfileBinding;
}

export async function releaseKernelRemoteSession(sessionId: string): Promise<void> {
  await retryWithBackoff(
    async () => {
      const apiKey = process.env.KERNEL_API_KEY?.trim();
      if (!apiKey) throw new Error('KERNEL_API_KEY is required to delete Kernel sessions');
      const baseUrl = (process.env.KERNEL_API_BASE_URL ?? 'https://api.onkernel.com').replace(
        /\/$/,
        ''
      );
      const url = new URL(`${baseUrl}/browsers/${encodeURIComponent(sessionId)}`);
      const statusCode = await new Promise<number>((resolve, reject) => {
        const request = https.request(
          url,
          { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode ?? 0));
          }
        );
        request.setTimeout(10_000, () => {
          request.destroy(new Error('Kernel session delete timed out'));
        });
        request.once('error', reject);
        request.end();
      });
      if (statusCode !== 204 && statusCode !== 404) {
        throw new Error(`Kernel session delete failed: HTTP ${statusCode}`);
      }
    },
    {
      maxRetries: 3,
      fixedDelays: [250, 500],
      isRetryable: () => true,
      component: 'Kernel session delete',
    }
  );
}

async function createProfile(
  contextId: string,
  agentId: string,
  boundProfile?: ProviderProfileBinding
): Promise<{
  profileId: string | null;
  profileSource: string;
}> {
  if (!browserProviderEnabled('KERNEL_PROFILE_ENABLED', true)) {
    if (boundProfile !== undefined) {
      throw new Error('A bound Kernel session requires browser profile support');
    }
    return { profileId: null, profileSource: 'disabled' };
  }
  if (boundProfile !== undefined) return boundProfile;
  const client = kernelClient();
  if (benchmarkIsolatedBrowserProfilesEnabled()) {
    try {
      // Deliberately bypass BrowserProviderProfile: that row is shared by every
      // benchmark agent because BrowserContext is unique per user.
      return await getOrCreateBenchmarkKernelProfile(client, agentId);
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        const message = `Kernel profiles are required but unavailable: ${error.message}`;
        if (browserProviderEnabled('KERNEL_PROFILE_REQUIRED', true)) {
          throw new Error(message, { cause: error });
        }
        log.warn(`${message}; using an ephemeral browser`);
        return { profileId: null, profileSource: 'unavailable_plan' };
      }
      throw error;
    }
  }
  const existing = await getProviderProfile(contextId, 'kernel');
  if (existing !== null) {
    return { profileId: existing, profileSource: 'user_persistent' };
  }

  let profile;
  try {
    profile = await client.profiles.create({});
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      const message = `Kernel profiles are required but unavailable: ${error.message}`;
      if (browserProviderEnabled('KERNEL_PROFILE_REQUIRED', true)) {
        throw new Error(message, { cause: error });
      }
      log.warn(`${message}; using an ephemeral browser`);
      return { profileId: null, profileSource: 'unavailable_plan' };
    }
    throw error;
  }
  try {
    await rememberProviderProfile(contextId, 'kernel', profile.id);
    return { profileId: profile.id, profileSource: 'new_user_persistent' };
  } catch (error) {
    const winner = await getProviderProfile(contextId, 'kernel');
    if (winner !== null) {
      await client.profiles.delete(profile.id).catch(() => {});
      return { profileId: winner, profileSource: 'user_persistent' };
    }
    throw error;
  }
}

async function createRemoteSession(
  contextId: string,
  agentId: string,
  proxyLocation: ProxyGeoLocation,
  // When set, the explicit/disabled proxy short-circuits are skipped and a fresh
  // managed proxy of this tier is resolved. Used by rotateKernelSession so
  // rotate_ip deterministically lands on residential/mobile instead of inheriting
  // the deployment's default proxy mode.
  options: KernelRemoteSessionOptions = {}
): Promise<{
  sessionId: string;
  debugUrl: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: string | null;
  profileSource: string;
  validationBrowser: Browser;
}> {
  const client = kernelClient();
  const profile = options.omitProfile
    ? { profileId: null, profileSource: 'challenge_candidate_ephemeral' }
    : await createProfile(contextId, agentId, options.boundProfile);
  const stealth = browserProviderEnabled('KERNEL_STEALTH_ENABLED', true);

  const createValidatedSession = async (proxy: KernelProxySelection) =>
    retryWithBackoff(
      async () => {
        const session = await client.browsers.create(
          {
            headless: browserProviderEnabled('KERNEL_HEADLESS_ENABLED', false),
            stealth,
            telemetry: kernelCaptchaTelemetryConfig(),
            gpu: browserProviderEnabled('KERNEL_GPU_ENABLED', false),
            // Do not let Chromium reopen the profile's previous window. The new-tab
            // page created by this policy is replaced below along with any unexpected
            // restored pages, leaving one clean bootstrap tab.
            chrome_policy: { RestoreOnStartup: 5 },
            timeout_seconds: kernelTimeoutSeconds(),
            viewport: { width: 1280, height: 800, refresh_rate: 60 },
            ...(profile.profileId !== null
              ? { profile: { id: profile.profileId, save_changes: true } }
              : {}),
            ...(proxy.proxyId !== undefined ? { proxy_id: proxy.proxyId } : {}),
            tags: { rose_agent_id: agentId, rose_session_request: randomUUID() },
          },
          KERNEL_CREATE_REQUEST_OPTIONS
        );
        const actualProfileId = session.profile?.id ?? null;
        // Only a required authenticated profile (Steel SessionAuth, H-07) fails
        // closed on mismatch. Kernel manages its own profiles and its create
        // response does not reliably echo the loaded id, so a best-effort
        // recreate binding tolerates a differing/NONE id (providerProfileMismatch
        // returns null) rather than 500ing the rotate/resume path.
        const profileMismatch = providerProfileMismatch(options.boundProfile, actualProfileId);
        if (profileMismatch !== null) {
          await releaseKernelRemoteSession(session.session_id);
          throw new KernelSessionValidationError(`Kernel ${profileMismatch}`);
        }

        const validationBrowser = await connectValidatedBrowser(session.cdp_ws_url);
        if (validationBrowser !== null) {
          try {
            await ensureKernelSessionFileDirectories(session.session_id);
            const closedTabCount = await resetKernelSessionTabs(validationBrowser);
            // Visible live-view cue while Kernel's stealth auto-solver runs.
            // Agent CDP attach re-installs this — validation connections close
            // before the worker attaches (see captchaSolveIndicator.ts).
            await installCaptchaSolveIndicator(validationBrowser);
            log.info('Reset restored Kernel profile tabs', {
              sessionId: session.session_id,
              closedTabCount,
            });
            return {
              sessionId: session.session_id,
              debugUrl: readOnlyLiveView(session.browser_live_view_url),
              wsUrl: session.cdp_ws_url,
              proxySource: proxy.proxySource,
              proxyLocation: proxy.proxyLocation,
              profileId: session.profile?.id ?? profile.profileId,
              profileSource: profile.profileSource,
              validationBrowser,
            };
          } catch (error) {
            await validationBrowser.close().catch(() => {});
            await releaseKernelRemoteSession(session.session_id).catch(() => {});
            throw new KernelSessionValidationError(
              `Kernel session ${session.session_id} failed tab reset: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }

        await releaseKernelRemoteSession(session.session_id).catch((error) => {
          log.warn('Failed to evict invalid Kernel session', {
            sessionId: session.session_id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        throw new KernelSessionValidationError(
          `Kernel session ${session.session_id} failed CDP validation`
        );
      },
      {
        maxRetries: 3,
        fixedDelays: [250, 500],
        isRetryable: (error) => error instanceof KernelSessionValidationError,
        component: 'Kernel CDP validation',
      }
    );

  const createWithManagedProxy = (
    candidates: ReturnType<typeof kernelProxyCandidates>
  ): ReturnType<typeof createValidatedSession> =>
    createSessionOnKernelProxyLadder(
      client,
      candidates,
      (resolved) =>
        createValidatedSession({
          proxyId: resolved.proxyId,
          proxyKey: resolved.proxyKey,
          proxySource: resolved.source,
          proxyLocation: resolved.location,
        }),
      {
        onRefresh: (candidate, error) =>
          log.warn('Kernel proxy was deleted; re-resolving the same location', {
            proxyKey: candidate.proxyKey,
            error: error instanceof Error ? error.message : String(error),
          }),
        onRelax: (candidate, error) =>
          log.warn('Kernel proxy location unavailable; relaxing location specificity', {
            proxyKey: candidate.proxyKey,
            error: error instanceof Error ? error.message : String(error),
          }),
      }
    );

  try {
    let remote;
    if (options.omitManagedProxy) {
      remote = await createValidatedSession({
        proxySource: stealth ? 'kernel_stealth' : 'none',
        proxyLocation,
      });
    } else if (options.exactManagedProxy !== undefined) {
      const exact = kernelProxyCandidates(proxyLocation, options.exactManagedProxy.type).find(
        (candidate) => candidate.source.endsWith(`_${options.exactManagedProxy?.specificity}`)
      );
      if (exact === undefined) {
        throw new Error(
          `Kernel ${options.exactManagedProxy.type} ${options.exactManagedProxy.specificity} proxy is unavailable for the requested location`
        );
      }
      remote = await createWithManagedProxy([exact]);
    } else if (options.forceManagedProxyType !== undefined) {
      remote = await createWithManagedProxy(
        kernelProxyCandidates(proxyLocation, options.forceManagedProxyType)
      );
    } else {
      const proxyMode = resolveKernelProxyMode();
      if (proxyMode.kind === 'explicit') {
        remote = await createValidatedSession({
          proxyId: proxyMode.proxyId,
          proxySource: 'kernel_configured',
          proxyLocation,
        });
      } else if (!browserProviderEnabled('KERNEL_PROXY_ENABLED', true)) {
        remote = await createValidatedSession({
          proxySource: stealth ? 'kernel_stealth' : 'none',
          proxyLocation,
        });
      } else {
        remote = await createWithManagedProxy(kernelProxyCandidates(proxyLocation));
      }
    }
    // Do not mark the profile bound here — persistBrowserSessionRow (or the
    // recreate row update) may still fail and release the remote session. A
    // premature bind would label the next retry user_persistent instead of
    // new_user_persistent (breaks webdecoy isolation metadata proofs).
    return remote;
  } catch (error) {
    if (error instanceof RateLimitError) {
      throw new BrowserProviderRateLimitError('kernel', error.message);
    }
    throw error;
  }
}

export async function createKernelSessionWithContext(
  contextId: string,
  agentId: string,
  proxyLocation: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  _startUrl?: string,
  options?: {
    keepValidationConnection?: boolean;
    taskId?: string;
    forceManagedProxyType?: KernelProxyType;
    exactManagedProxy?: {
      type: KernelProxyType;
      specificity: KernelRecoveryProxySpecificity;
    };
  }
): Promise<BrowserProviderSession> {
  const remote = await createRemoteSession(contextId, agentId, proxyLocation, {
    forceManagedProxyType: options?.forceManagedProxyType,
    exactManagedProxy: options?.exactManagedProxy,
  });
  let dbSession;
  try {
    dbSession = await persistBrowserSessionRow({
      taskId: options?.taskId,
      contextId,
      agentId,
      sessionId: remote.sessionId,
      debugUrl: remote.debugUrl,
      wsUrl: remote.wsUrl,
      startUrl: _startUrl || undefined,
      provider: 'kernel',
      ...providerProfileData(remote.profileId, remote.profileSource, true),
      releaseRemoteSession: releaseKernelRemoteSession,
    });
  } catch (error) {
    await Promise.allSettled([
      releaseKernelRemoteSession(remote.sessionId),
      remote.validationBrowser.close(),
    ]);
    throw error;
  }
  // Bind only after the session row is durable so a failed persist leaves the
  // in-memory profile as new_user_persistent for the next create attempt.
  if (remote.profileId !== null) {
    await markBenchmarkKernelProfileBound(agentId, remote.profileId);
  }

  let validationBrowser: Browser | null = remote.validationBrowser;
  if (!options?.keepValidationConnection) {
    await validationBrowser.close().catch(() => {});
    validationBrowser = null;
  }

  log.info('Created Kernel browser session', {
    sessionId: remote.sessionId,
    contextId,
    profileId: remote.profileId,
  });

  return {
    provider: 'kernel',
    taskId: dbSession.id,
    ...remote,
    validationBrowser,
  };
}

/** Create a solver-enabled, profile-free Kernel candidate for challenge search. */
export async function createKernelRecoverySession(
  agentId: string,
  proxyLocation: ProxyGeoLocation,
  proxy:
    | { type: KernelProxyType; specificity: KernelRecoveryProxySpecificity }
    | { omitManagedProxy: true }
) {
  if ('omitManagedProxy' in proxy) {
    return createRemoteSession('', agentId, proxyLocation, {
      omitManagedProxy: true,
      omitProfile: true,
    });
  }
  return createRemoteSession('', agentId, proxyLocation, {
    exactManagedProxy: proxy,
    omitProfile: true,
  });
}

export async function closeKernelSession(
  sessionId: string,
  pause = false,
  currentUrl?: string
): Promise<void> {
  let releaseError: unknown = null;
  try {
    await releaseKernelRemoteSession(sessionId);
  } catch (error) {
    releaseError = error;
    log.warn('Failed to delete Kernel session; retaining retryable local session state', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: releaseError === null ? (pause ? 'PAUSED' : 'CLOSED') : pause ? 'ACTIVE' : 'ERROR',
      closedAt: releaseError === null && !pause ? new Date() : null,
      currentUrl: currentUrl || undefined,
    },
  });

  if (releaseError !== null) throw releaseError;
}

/**
 * Recreate a Kernel browser session on the SAME persistent profile (cookies/login
 * survive), re-navigating to the last URL. Shared by resume (paused → active) and
 * rotate_ip (swap the egress IP mid-run). `forceManagedProxyType` pins the new
 * session to a residential/mobile tier; `proxyTier` records that on the row.
 */
function persistedKernelProxyOptions(proxyTier: string | null): KernelRemoteSessionOptions {
  if (proxyTier === 'none') return { omitManagedProxy: true };
  const match = /^(residential|mobile|isp)(?:_(city|state|country))?$/.exec(proxyTier ?? '');
  if (match === null) return {};
  const type = match[1] as KernelProxyType;
  const specificity = match[2] as KernelRecoveryProxySpecificity | undefined;
  return specificity === undefined
    ? { forceManagedProxyType: type }
    : { exactManagedProxy: { type, specificity } };
}

async function recreateKernelSession(
  taskId: string,
  opts: { forceManagedProxyType?: KernelProxyType; proxyTier?: string } = {}
): Promise<BrowserProviderResumeSession> {
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });
  if (oldSession === null) throw new Error(`Browser task not found: ${taskId}`);

  const agent = await prisma.agent.findUnique({
    where: { id: oldSession.agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  const proxyLocation: ProxyGeoLocation = agent?.proxyCountry
    ? {
        country: agent.proxyCountry,
        ...(agent.proxyState ? { state: agent.proxyState } : {}),
        ...(agent.proxyCity ? { city: agent.proxyCity } : {}),
      }
    : DEFAULT_GEOLOCATION;

  const previousSessionId = oldSession.sessionId;

  const remote = await createRemoteSession(
    oldSession.contextId,
    oldSession.agentId,
    proxyLocation,
    {
      ...(opts.forceManagedProxyType === undefined
        ? persistedKernelProxyOptions(oldSession.proxyTier)
        : { forceManagedProxyType: opts.forceManagedProxyType }),
      boundProfile: recordedProviderProfileBinding(oldSession),
    }
  );
  await remote.validationBrowser.close().catch(() => {});

  const replaced = await prisma.browserSession.updateMany({
    where: { id: taskId, sessionId: previousSessionId },
    data: {
      sessionId: remote.sessionId,
      debugUrl: remote.debugUrl,
      wsUrl: remote.wsUrl,
      status: 'ACTIVE',
      closedAt: null,
      provider: 'kernel',
      ...providerProfileData(remote.profileId, remote.profileSource, true),
      ...(opts.proxyTier !== undefined ? { proxyTier: opts.proxyTier } : {}),
    },
  });

  if (replaced.count !== 1) {
    await Promise.allSettled([
      releaseKernelRemoteSession(remote.sessionId),
      remote.validationBrowser.close(),
    ]);
    throw new Error(`Browser session changed concurrently while recreating task ${taskId}`);
  }
  if (remote.profileId !== null) {
    await markBenchmarkKernelProfileBound(oldSession.agentId, remote.profileId);
  }

  // Evict the superseded Kernel browser so we never leak a paid session. On the
  // resume path the old browser was already deleted at pause time (delete
  // tolerates 404); on the rotate path it is still live and must be reaped.
  if (previousSessionId !== '' && previousSessionId !== remote.sessionId) {
    await releaseKernelRemoteSession(previousSessionId).catch((error) => {
      log.warn('Failed to evict superseded Kernel session after recreate', {
        previousSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const savedUrl = oldSession.currentUrl || oldSession.startUrl || undefined;
  if (savedUrl && (await validateSessionConnection(remote.wsUrl))) {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(remote.wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
    await browser.close().catch(() => {});
  }

  return {
    provider: 'kernel',
    debugUrl: remote.debugUrl,
    sessionId: remote.sessionId,
    wsUrl: remote.wsUrl,
    savedUrl,
    proxySource: remote.proxySource,
    proxyLocation: remote.proxyLocation,
    profileId: remote.profileId,
    profileSource: remote.profileSource,
  };
}

export async function resumeKernelSession(taskId: string): Promise<BrowserProviderResumeSession> {
  return recreateKernelSession(taskId);
}

/**
 * Rotate the session's outbound IP by recreating it on a fresh managed proxy of
 * the given tier (residential → new exit IP, mobile → carrier IP). Same profile,
 * same geo. Backs the rotate_ip browser tool.
 */
export async function rotateKernelSession(
  taskId: string,
  proxyType: KernelProxyType
): Promise<BrowserProviderResumeSession> {
  return recreateKernelSession(taskId, {
    forceManagedProxyType: proxyType,
    proxyTier: proxyType,
  });
}

export async function getKernelSessionHealth(sessionId: string): Promise<BrowserSessionHealth> {
  const session = await kernelClient().browsers.retrieve(sessionId, { include_deleted: true });
  return {
    provider: 'kernel',
    sessionId,
    status: session.deleted_at ? 'deleted' : 'active',
    createdAt: session.created_at,
    timeoutMs: session.timeout_seconds * 1000,
    expiresAt: null,
    ttlMs: null,
    profileId: session.profile?.id ?? null,
    uptimeMs: session.usage?.uptime_ms ?? null,
  };
}
