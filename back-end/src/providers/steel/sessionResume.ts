import type SteelSDK from 'steel-sdk';
import type { Prisma } from '@prisma/client';
import type { Browser } from 'playwright';
import { prisma } from '../database';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { getProviderProfile, rememberProviderProfile } from '../browser/context';
import { reusableSteelRecordedProfileId } from './profileBinding';
export { reusableSteelRecordedProfileId } from './profileBinding';
import { storedBrowserProvider, type BrowserProviderName } from '../browser/types';
import { SteelRateLimitError, type FingerprintData, log } from './types';
import {
  MAX_SESSION_RETRIES,
  SteelSessionCleanupError,
  buildSteelProxySettings,
  envEnabled,
  isInvalidSteelProxyConfiguration,
  isKnownRejectedProxyCity,
  releaseSteelRemoteSession,
  rememberRejectedProxyCity,
  rememberBenchmarkAnonSteelProfile,
  resolveSteelProfileForSession,
  steel,
  steelCdpUrl,
  steelDebugUrl,
} from './session';
import { rotationGeolocation } from './sessionProxy';
import {
  STEEL_CDP_TIMEOUT_MESSAGE,
  steelStartupProbe,
  validateBrowserConnection,
} from './sessionConnection';
import { steelSessionTimeoutMs } from './sessionLifetime';
import {
  newOwnedSteelSessionId,
  registerInFlightSteelSession,
  unregisterInFlightSteelSession,
} from './sessionIdentity';
import { steelCdpConnectionUrl } from './urls';
import { announceBrowserSessionBinding } from '../browser/sessionBindingAnnounce';
import {
  withSteelLifecycleClaim,
  withBrowserResumeClaim,
  browserResumeScope,
  type SteelNativeEffect,
  type SteelLifecycleMutation,
} from './lifecycleClaim';
import { prepareSteelCandidateCleanup, settleSteelCandidateCleanup } from './candidateCleanup';
import {
  finishSteelProfileWriter,
  type SteelReplacementProfileDependencies,
} from './replacementProfile';

function hasValue(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

/** Backoff between Steel create attempts so transient "Connection error" flakes can clear. */
function sleepBeforeSteelRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(2_000, 250 * 2 ** (attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

class ConcurrentSessionReplacementError extends Error {
  constructor(taskId: string) {
    super(`Browser session changed concurrently while recreating task ${taskId}`);
    this.name = 'ConcurrentSessionReplacementError';
  }
}

class SteelProfileFailedError extends Error {}

async function proxyLocationForAgent(agentId: string | null): Promise<ProxyGeoLocation> {
  if (!hasValue(agentId)) return DEFAULT_GEOLOCATION;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  if (!hasValue(agent?.proxyCountry)) return DEFAULT_GEOLOCATION;

  return {
    country: agent.proxyCountry,
    ...(hasValue(agent.proxyState) ? { state: agent.proxyState } : {}),
    ...(hasValue(agent.proxyCity) ? { city: agent.proxyCity } : {}),
  };
}

async function fingerprintUserAgent(userId: string): Promise<string | undefined> {
  const fingerprint = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'browser_fingerprint', accountId: '' } },
  });
  const fp = (fingerprint?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  return hasValue(fp?.navigator?.userAgent) ? fp.navigator.userAgent : undefined;
}

async function connectSteelBrowser(wsUrl: string): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(steelCdpConnectionUrl(wsUrl));
}

export async function navigateToSavedUrl(
  wsUrl: string,
  savedUrl: string | undefined,
  connectBrowser: (url: string) => Promise<Browser> = connectSteelBrowser,
  borrowedBrowser?: Browser
): Promise<void> {
  if (!hasValue(savedUrl)) return;

  log.info(`  Navigating session to saved URL: ${savedUrl}`);
  let browser: Browser | undefined;
  try {
    browser = borrowedBrowser ?? (await connectBrowser(wsUrl));
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(savedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    });
    log.info('  Navigation complete');
  } catch (navError) {
    log.error('Failed to navigate to saved URL', {
      error: navError instanceof Error ? navError.message : String(navError),
    });
  } finally {
    if (browser && !borrowedBrowser) await browser.close().catch(() => {});
  }
}

export interface RecreatedSteelSession {
  validationBrowser?: Browser;
  debugUrl: string;
  sessionId: string;
  wsUrl: string;
  savedUrl?: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  steelProfileId: string | null;
  profileSource: string;
  previousSessionId: string | null;
  previousProvider: BrowserProviderName;
  previousSessionReleased: boolean;
}

export interface SteelSessionReplacementDependencies extends SteelReplacementProfileDependencies {
  withLifecycleClaim?: typeof withSteelLifecycleClaim;
  prepareCandidateCleanup?: typeof prepareSteelCandidateCleanup;
  settleCandidateCleanup?: typeof settleSteelCandidateCleanup;
  resolveCandidateCustody?: (sessionId: string) => Promise<boolean>;
  createSession: (input: SteelSDK.SessionCreateParams) => Promise<{
    id: string;
    debugUrl: string;
    profileId?: string | null;
    proxySource?: string | null;
  }>;
  /** Resolves null when the session accepts CDP, otherwise the failure reason. */
  validateConnection: (
    wsUrl: string,
    sessionId: string
  ) => Promise<string | null | { browser: Browser | null; failure: string | null }>;
  releaseSession?: (sessionId: string) => Promise<void>;
  retrieveProfile?: (profileId: string) => Promise<{ status: string }>;
}

const defaultReplacementDependencies: SteelSessionReplacementDependencies = {
  createSession: async (input) => steel.sessions.create(input),
  validateConnection: async (wsUrl, sessionId) => {
    const validation = await validateBrowserConnection(wsUrl, {
      startupProbe: steelStartupProbe(sessionId, (id) => steel.sessions.retrieve(id)),
    });
    return validation;
  },
};

type SteelReplacementOptions = {
  forceManagedRotation: boolean;
  forceFreshProfile?: boolean;
  keepValidationConnection?: boolean;
};

export async function recreateSession(
  taskId: string,
  options: SteelReplacementOptions,
  dependencies: SteelSessionReplacementDependencies = defaultReplacementDependencies
): Promise<RecreatedSteelSession> {
  const claim =
    dependencies.withLifecycleClaim ??
    (browserResumeScope() ? withBrowserResumeClaim : withSteelLifecycleClaim);
  // A replacement is handed off only once every enclosing claim settles. If a
  // claim rejects after publication, close the unreturned validation transport
  // and forward that claim's original error.
  let produced: RecreatedSteelSession | undefined;
  const replacement = claim(
    taskId,
    async (assertTask, runTaskNative, mutateTask, resolveTaskCustody) => {
      const row = await prisma.browserSession.findUnique({
        where: { id: taskId },
        include: { context: true },
      });
      if (row === null) throw new Error(`Browser task not found: ${taskId}`);
      const recordedProfileId = options.forceFreshProfile
        ? null
        : reusableSteelRecordedProfileId(row);
      const persistedProfileId =
        recordedProfileId ??
        (options.forceFreshProfile ? null : await getProviderProfile(row.contextId, 'steel'));
      const boundProfile =
        recordedProfileId !== null
          ? {
              profileId: recordedProfileId,
              profileSource: row.providerProfileSource ?? 'session_bound',
              persistProfile: row.providerProfilePersist ?? true,
            }
          : undefined;
      const profile = resolveSteelProfileForSession(
        options.forceFreshProfile ? null : row.agentId,
        persistedProfileId,
        null,
        boundProfile
      );
      const run = async (
        assertProfile?: () => Promise<void>,
        runProfileNative?: SteelNativeEffect,
        mutateProfile?: SteelLifecycleMutation,
        resolveProfileCustody?: import('./lifecycleClaim').SteelNativeCustodyResolver
      ) =>
        (produced = await recreateSessionWithinClaim(
          taskId,
          options,
          {
            ...dependencies,
            resolveCandidateCustody: resolveTaskCustody
              ? async (id) => {
                  const inspect = () =>
                    (
                      dependencies.inspectSession ??
                      ((nativeId: string) => steel.sessions.retrieve(nativeId))
                    )(id);
                  const release = () =>
                    (dependencies.releaseSession ?? releaseSteelRemoteSession)(id);
                  if (resolveProfileCustody && !(await resolveProfileCustody(id, inspect, release)))
                    return false;
                  return resolveTaskCustody(id, inspect, release);
                }
              : dependencies.resolveCandidateCustody,
            mutateLifecycle: mutateTask
              ? (callback) =>
                  mutateTask((transaction) =>
                    mutateProfile ? mutateProfile(callback, transaction) : callback(transaction)
                  )
              : dependencies.mutateLifecycle,
            runOwnedNative: async (id, effect, callback) => {
              const native = () =>
                runProfileNative ? runProfileNative(id, effect, callback) : callback();
              return runTaskNative ? runTaskNative(id, effect, native) : native();
            },
            verifyLifecycleOwnership: async () => {
              await assertTask?.();
              await assertProfile?.();
            },
          },
          { row, recordedProfileId, profile }
        ));
      return profile.profileId ? claim(`profile:${profile.profileId}`, run) : run();
    }
  );
  try {
    return await replacement;
  } catch (error) {
    await produced?.validationBrowser?.close().catch(() => {});
    throw error;
  }
}

type SteelReplacementSnapshot = {
  row: Prisma.BrowserSessionGetPayload<{ include: { context: true } }>;
  recordedProfileId: string | null;
  profile: ReturnType<typeof resolveSteelProfileForSession>;
};

async function recreateSessionWithinClaim(
  taskId: string,
  options: SteelReplacementOptions,
  dependencies: SteelSessionReplacementDependencies,
  snapshot: SteelReplacementSnapshot
): Promise<RecreatedSteelSession> {
  const operation = options.forceManagedRotation ? 'Rotating' : 'Resuming';
  log.info(`${operation} browser task ${taskId} on Steel...`);
  const oldSession = snapshot.row;
  const steelRecordedProfileId = snapshot.recordedProfileId;
  const profile = snapshot.profile;

  // The superseded session is released through this provider, so a Tilion (or
  // any recognised) row must keep its own name instead of collapsing to Steel.
  const previousProvider: BrowserProviderName = storedBrowserProvider(oldSession.provider);
  const savedUrl = hasValue(oldSession.currentUrl)
    ? oldSession.currentUrl
    : hasValue(oldSession.startUrl)
      ? oldSession.startUrl
      : undefined;
  log.info(`  Found old session with saved URL: ${savedUrl ?? 'NONE'}`);
  const baseGeo = await proxyLocationForAgent(oldSession.agentId);
  // A rotation must land on a different egress IP; see rotationGeolocation. The
  // caller already reserved this rotation, so the row's count is its step.
  const proxyGeo = options.forceManagedRotation
    ? rotationGeolocation(baseGeo, taskId, oldSession.proxyRotationCount)
    : baseGeo;
  log.info(`  Using proxy location: ${proxyGeo.city}, ${proxyGeo.state}, ${proxyGeo.country}`);
  const userAgent = await fingerprintUserAgent(oldSession.context.userId);
  let dropProxyCity = isKnownRejectedProxyCity(proxyGeo);

  let lastError: Error | null = null;
  let attemptsMade = 0;
  let consecutiveCdpTimeouts = 0;
  const finishWriter =
    oldSession.provider === 'steel' &&
    steelRecordedProfileId !== null &&
    oldSession.providerProfilePersist;
  let writerReleased = false;
  if (finishWriter && oldSession.sessionId !== null) {
    await finishSteelProfileWriter(
      { ...oldSession, sessionId: oldSession.sessionId, providerProfileId: steelRecordedProfileId },
      dependencies
    );
    writerReleased = true;
  }
  try {
    for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
      attemptsMade = attempt;
      log.info(`  Steel session attempt ${attempt}/${MAX_SESSION_RETRIES}...`);
      let createdSessionId: string | null = null;
      let createAcknowledged = false;
      let committed = false;
      let attemptCdpTimedOut = false;
      let validationBrowser: Browser | undefined;
      try {
        if (writerReleased && steelRecordedProfileId !== null) {
          await dependencies.verifyLifecycleOwnership?.();
          const persistedProfile = await (
            dependencies.retrieveProfile ??
            ((id: string) =>
              steel.get<unknown, { status: string }>(`/v1/profiles/${encodeURIComponent(id)}`))
          )(steelRecordedProfileId);
          await dependencies.verifyLifecycleOwnership?.();
          if (persistedProfile.status === 'FAILED') {
            throw new SteelProfileFailedError(
              `Steel profile ${steelRecordedProfileId} failed to persist`
            );
          }
          if (persistedProfile.status !== 'READY') {
            throw new Error(
              `Steel profile ${steelRecordedProfileId} is not ready (${persistedProfile.status})`
            );
          }
        }
        const proxySettings = buildSteelProxySettings(
          proxyGeo,
          dropProxyCity,
          options.forceManagedRotation
        );
        await dependencies.verifyLifecycleOwnership?.();
        const intent = await browserResumeScope()?.beforeCreate('steel', newOwnedSteelSessionId());
        const requestedSessionId =
          intent?.recoveredId ?? intent?.marker ?? newOwnedSteelSessionId();
        await (dependencies.prepareCandidateCleanup ?? prepareSteelCandidateCleanup)(
          taskId,
          requestedSessionId,
          profile.profileId
        );
        createdSessionId = requestedSessionId;
        await registerInFlightSteelSession(requestedSessionId);
        const create = () =>
          intent?.recoveredId
            ? steel.sessions.retrieve(intent.recoveredId)
            : dependencies.createSession({
                sessionId: requestedSessionId,
                profileId: profile.profileId,
                persistProfile: profile.persistProfile,
                userAgent:
                  userAgent !== undefined &&
                  envEnabled('BROWSER_AGENT_STEEL_USER_AGENT_ENABLED', true)
                    ? userAgent
                    : undefined,
                useProxy: proxySettings.config,
                solveCaptcha: envEnabled('BROWSER_AGENT_STEEL_CAPTCHA_SOLVER_ENABLED', true),
                debugConfig: { systemCursor: false },
                stealthConfig: { humanizeInteractions: false, skipFingerprintInjection: true },
                timeout: steelSessionTimeoutMs(),
                dimensions: { width: 1288, height: 891 },
              });
        const session = dependencies.runOwnedNative
          ? await dependencies.runOwnedNative(requestedSessionId, 'create', create)
          : await create();
        createAcknowledged = true;
        // Capture the acknowledged allocation before any fallible bookkeeping.
        createdSessionId = session.id;
        await registerInFlightSteelSession(session.id);
        if (session.id !== requestedSessionId) {
          await (dependencies.prepareCandidateCleanup ?? prepareSteelCandidateCleanup)(
            taskId,
            session.id,
            profile.profileId
          );
          // Never adopt a provider ID outside the client-selected ownership
          // contract, or discharge the requested ID merely from a different echo.
          throw new Error('Steel returned a different session ID than requested');
        }

        if (profile.profileId !== undefined && session.profileId !== profile.profileId) {
          throw new Error(
            `Steel loaded profile ${session.profileId ?? 'NONE'} instead of bound profile ${profile.profileId}`
          );
        }

        log.info(`  Created new Steel session: ${session.id}`);
        if (profile.profileSource.startsWith('benchmark_anon')) {
          rememberBenchmarkAnonSteelProfile(oldSession.agentId, session.profileId);
        }
        const debugUrl = steelDebugUrl(session.debugUrl);
        const wsUrl = steelCdpUrl(session.id);

        const validation = await dependencies.validateConnection(wsUrl, session.id);
        const validationFailure =
          typeof validation === 'object' && validation !== null ? validation.failure : validation;
        validationBrowser =
          typeof validation === 'object' && validation !== null
            ? (validation.browser ?? undefined)
            : undefined;
        if (!options.keepValidationConnection) {
          await validationBrowser?.close().catch(() => {});
          validationBrowser = undefined;
        }
        if (validationFailure !== null) {
          attemptCdpTimedOut = validationFailure === STEEL_CDP_TIMEOUT_MESSAGE;
          throw new Error(`Session validation failed on attempt ${attempt}: ${validationFailure}`);
        }

        if (!oldSession.logicalOwnerKey)
          await navigateToSavedUrl(wsUrl, savedUrl, connectSteelBrowser, validationBrowser);
        await dependencies.verifyLifecycleOwnership?.();
        const mutate: SteelLifecycleMutation =
          dependencies.mutateLifecycle ?? (async (callback) => callback(prisma));
        const replaced = await mutate((transaction) =>
          transaction.browserSession.updateMany({
            where: {
              id: taskId,
              sessionId: oldSession.sessionId,
              provider: oldSession.provider,
              providerProfileId: oldSession.providerProfileId,
              providerProfileSource: oldSession.providerProfileSource,
              providerProfilePersist: oldSession.providerProfilePersist,
              ...(writerReleased
                ? { status: 'PAUSED' as const, closedAt: null }
                : oldSession.status
                  ? { status: oldSession.status, closedAt: oldSession.closedAt }
                  : {}),
            },
            data: {
              sessionId: session.id,
              debugUrl,
              wsUrl,
              status: oldSession.logicalOwnerKey ? 'PAUSED' : 'ACTIVE',
              closedAt: null,
              provider: 'steel',
              kernelProxySource: null,
              providerProfileId: session.profileId ?? profile.profileId ?? null,
              providerProfileSource: profile.profileSource,
              providerProfilePersist: profile.persistProfile,
              ...(options.forceManagedRotation ? { proxyTier: 'residential' } : {}),
            },
          })
        );
        if (replaced.count !== 1) throw new ConcurrentSessionReplacementError(taskId);
        committed = true;
        await (dependencies.settleCandidateCleanup ?? settleSteelCandidateCleanup)(
          session.id,
          'COMMITTED'
        ).catch((error: unknown) => {
          log.error('Committed Steel candidate cleanup bookkeeping remains pending', {
            taskId,
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        await unregisterInFlightSteelSession(session.id);
        await announceBrowserSessionBinding({ id: taskId });

        if (
          profile.persistProfile &&
          session.profileId &&
          !profile.profileSource.startsWith('benchmark_anon')
        ) {
          await rememberProviderProfile(oldSession.contextId, 'steel', session.profileId).catch(
            (profileError) => {
              log.warn('Failed to persist Steel provider profile after session replacement', {
                taskId,
                profileId: session.profileId,
                error: profileError instanceof Error ? profileError.message : String(profileError),
              });
            }
          );
        }

        log.info(`Task moved to Steel session ${session.id}`);
        return {
          ...(validationBrowser ? { validationBrowser } : {}),
          previousSessionReleased: writerReleased,
          debugUrl,
          sessionId: session.id,
          wsUrl,
          savedUrl,
          proxySource:
            (session as { proxySource?: string | null }).proxySource ?? proxySettings.source,
          proxyLocation: proxyGeo,
          steelProfileId: session.profileId ?? profile.profileId ?? null,
          profileSource: profile.profileSource,
          previousSessionId: oldSession.sessionId,
          previousProvider,
        };
      } catch (error) {
        // An unreturned validation connection is never retained by the caller.
        await validationBrowser?.close().catch(() => {});
        validationBrowser = undefined;
        if (committed) throw error;
        const createStatus =
          (error as { status?: number; statusCode?: number }).status ??
          (error as { statusCode?: number }).statusCode;
        if (
          !createAcknowledged &&
          ((error as { steelNativeRequestNotIssued?: boolean }).steelNativeRequestNotIssued ===
            true ||
            (createStatus !== undefined &&
              createStatus >= 400 &&
              createStatus < 500 &&
              createStatus !== 408)) &&
          createdSessionId !== null
        ) {
          await (dependencies.settleCandidateCleanup ?? settleSteelCandidateCleanup)(
            createdSessionId,
            'RELEASED'
          );
          await unregisterInFlightSteelSession(createdSessionId);
          createdSessionId = null;
        }
        if (!createAcknowledged && createdSessionId !== null) {
          // Transport/5xx/408 failure can precede allocation. A release 404
          // cannot discharge this intent; exact native reconciliation owns it.
          const resolved = await dependencies.resolveCandidateCustody?.(createdSessionId);
          if (resolved !== true) throw new SteelSessionCleanupError(createdSessionId, error);
          await (dependencies.settleCandidateCleanup ?? settleSteelCandidateCleanup)(
            createdSessionId,
            'RELEASED'
          );
          await unregisterInFlightSteelSession(createdSessionId);
          createdSessionId = null;
        }
        if (!committed && createdSessionId !== null) {
          const uncommittedSessionId = createdSessionId;
          try {
            const release = () =>
              (dependencies.releaseSession ?? releaseSteelRemoteSession)(uncommittedSessionId);
            await (dependencies.runOwnedNative
              ? dependencies.runOwnedNative(uncommittedSessionId, 'release', release)
              : release());
            const terminal = await (
              dependencies.inspectSession ?? ((id: string) => steel.sessions.retrieve(id))
            )(uncommittedSessionId);
            if (terminal.id !== uncommittedSessionId || terminal.status !== 'released') {
              throw new Error('Owned Steel candidate release remains unconfirmed');
            }
            await (dependencies.settleCandidateCleanup ?? settleSteelCandidateCleanup)(
              uncommittedSessionId,
              'RELEASED'
            );
            await browserResumeScope()?.settleCreate(uncommittedSessionId);
            await unregisterInFlightSteelSession(uncommittedSessionId);
            createdSessionId = null;
          } catch (releaseError) {
            await registerInFlightSteelSession(uncommittedSessionId);
            throw new SteelSessionCleanupError(uncommittedSessionId, releaseError);
          }
        }
        if (error instanceof ConcurrentSessionReplacementError) throw error;
        if (error instanceof SteelProfileFailedError) throw error;

        const status =
          (error as Record<string, unknown>)?.status ??
          (error as Record<string, unknown>)?.statusCode;
        if (status === 429) {
          const message =
            error instanceof Error ? error.message : 'Steel session rate limit exceeded';
          throw new SteelRateLimitError(message);
        }
        lastError = error instanceof Error ? error : new Error('Unknown error');
        log.info(`  Steel session attempt ${attempt} failed: ${lastError.message}`);
        consecutiveCdpTimeouts =
          attemptCdpTimedOut || lastError.message === STEEL_CDP_TIMEOUT_MESSAGE
            ? consecutiveCdpTimeouts + 1
            : 0;
        // Each timeout already includes three CDP handshakes against a distinct
        // new session. Two in a row indicate a provider transport outage; leave
        // the old session intact and let browser recovery try another provider.
        if (consecutiveCdpTimeouts >= 2) break;
        if (!dropProxyCity && isInvalidSteelProxyConfiguration(error)) {
          dropProxyCity = true;
          rememberRejectedProxyCity(proxyGeo);
          log.info('  Dropping unsupported Steel proxy city during replacement retry');
        }
        if (attempt < MAX_SESSION_RETRIES) {
          await sleepBeforeSteelRetry(attempt);
        }
      }
    }

    throw new Error(
      `Failed to create Steel replacement after ${attemptsMade} attempts: ${lastError?.message}`
    );
  } catch (error) {
    // Confirmed source release retains the PAUSED full-profile recovery binding.
    // Uncertain release is recorded as ERROR by finishSteelProfileWriter.
    // Never write after losing the lifecycle owner or a concurrent close.
    if (writerReleased) await announceBrowserSessionBinding({ id: taskId });
    throw error;
  }
}

export async function resumeSession(
  taskId: string,
  options: Omit<SteelReplacementOptions, 'forceManagedRotation'> = {}
): Promise<RecreatedSteelSession> {
  return recreateSession(taskId, { ...options, forceManagedRotation: false });
}

export async function rotateSession(
  taskId: string,
  options: { keepValidationConnection?: boolean } = {}
): Promise<RecreatedSteelSession> {
  return recreateSession(taskId, { ...options, forceManagedRotation: true });
}
