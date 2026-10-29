import {
  serializePasswords,
  serializePasskeys,
  type UserSettings,
  type SerializedPassword,
  type SerializedPasskey,
} from './browser/resumeCredentials';
export type {
  UserSettings,
  SerializedPassword,
  SerializedPasskey,
} from './browser/resumeCredentials';
import {
  checkpointLogicalBrowser,
  loadLogicalBrowserCheckpoint,
  restoreLogicalBrowserCheckpoint,
} from './browser/checkpoint';
import { isConfirmedBrowserEnd, recordEndedLogicalBrowser } from './browser/sessionPersist';
import { BROWSER_SESSION_MIN_REMAINING_MS } from './steel/sessionLifetime';
import { assertBrowserInitializationReady } from './browser/initialization';
import {
  browserResumeScope,
  withBrowserResumeClaim,
  withBrowserResumeLifecycle,
} from './steel/lifecycleClaim';
import { inspectResumeCandidate } from './browser/resumeRecovery';
import { failedHydrationCleanup } from './browser/resumeLifecycle';
import { withOwnedResumeTransport } from './browser/resumeTransport';
/* c8 ignore start -- resumeBrowserSession requires Steel SDK */
import { prisma } from './database';
import { DEFAULT_GEOLOCATION } from './geoip';
import { createLogger } from './logger';
import { canonicalAuthRealm } from './authRealm';
import {
  closeSession,
  getBrowserCaptchaTelemetry,
  getBrowserSessionHealth,
  getFingerprintInjectionData,
  injectUserData,
  resumeSession,
  rotateProxy,
} from './browser';
import {
  isTilionExitUnavailableError,
  ROTATION_CAP,
  rungAfterTilionUnavailable,
  nextRecoveryLabel,
  recoverySameProviderOnly,
  rotationStepLabel,
  sameProviderRotationStep,
  selectRotationStep,
  type RotationStep,
} from './browser/rotation';
import type { TilionCarriedState } from './browser/tilion';
import { clearPausedState, restoreTilionBrowserState } from './browser/tilionState';
import {
  applyCarriedStateToReplacement,
  carryForTilionSwitch,
  withTilionSwitchCarry,
} from './browserSwitchCarry';
import { storedBrowserProvider } from './browser/types';
import { browserProviderEnabled, browserUseEnabled } from './browser/config';
import {
  findPasswords,
  findUserSettings,
  reservePasskeysForRealm,
  toUserSettings,
} from './browser/resumeCredentialLookups';
import { buildRotationMessage } from './browser/rotationMessage';
export { buildRotationMessage };

export {
  ProxyRotationExhaustedError,
  RotationSessionNotFoundError,
  SameProviderRotationExhaustedError,
} from './browserRotationErrors';
import {
  ProxyRotationExhaustedError,
  RotationSessionNotFoundError,
  SameProviderRotationExhaustedError,
} from './browserRotationErrors';

const log = createLogger('BrowserSessionResume');

/** Provider operations behind resume/rotate_ip, injectable for persistence tests. */
export interface BrowserSessionResumeDependencies {
  resumeSession: typeof resumeSession;
  rotateProxy: typeof rotateProxy;
  injectUserData: typeof injectUserData;
  closeSession: typeof closeSession;
  getBrowserCaptchaTelemetry: typeof getBrowserCaptchaTelemetry;
  /** Writes worker-carried state into a non-Tilion replacement (defaults to the real restore). */
  restoreCarriedState?: typeof restoreTilionBrowserState;
  /** Whether a Tilion session is still running (defaults to Tilion /status). */
  tilionSessionLive?: (sessionId: string) => Promise<boolean>;
}

/**
 * Worker-captured browser state (cookies, localStorage, IndexedDB; Playwright
 * storageState shape). Tilion admits one CDP client, so the backend never
 * harvests a live Tilion session itself: the worker's capture is the state a
 * Tilion replacement carries.
 */
export interface BrowserStateCarry {
  carriedState?: TilionCarriedState;
}

/** Provider options for a replacement; a non-literal so providers ignoring the carry still type-check. */
function replacementOptions(carry: BrowserStateCarry) {
  const options: { keepValidationConnection: true; carriedState?: TilionCarriedState } = {
    keepValidationConnection: true,
  };
  if (carry.carriedState !== undefined) options.carriedState = carry.carriedState;
  return options;
}

const defaultResumeDependencies: BrowserSessionResumeDependencies = {
  resumeSession,
  rotateProxy,
  injectUserData,
  closeSession,
  getBrowserCaptchaTelemetry,
};

/** Tilion kill switch: off means no rotation step ever lands on a new Tilion session. */
function tilionRotationAvailable(): boolean {
  return browserProviderEnabled('BROWSER_AGENT_TILION_ENABLED', true);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('CAPTCHA telemetry request timed out')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type InjectionResult = Awaited<ReturnType<typeof injectUserData>>;

export async function resumeBrowserSession(
  taskId: string,
  options: { forceFreshProfile?: boolean } & BrowserStateCarry = {},
  dependencies: BrowserSessionResumeDependencies = defaultResumeDependencies
) {
  log.info('Resuming browser task', {
    taskId,
    forceFreshProfile: options.forceFreshProfile,
  });

  const read = () => prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  let initial = await read();
  if (initial.logicalOwnerKey && initial.status === 'ERROR') {
    const health = initial.sessionId ? await getBrowserSessionHealth(initial.sessionId) : null;
    if (
      !initial.sessionId ||
      !health ||
      !(await recordEndedLogicalBrowser(taskId, initial.sessionId, health))
    )
      throw new Error('Browser release outcome remains unresolved');
    initial = await read();
  }
  if (initial.logicalOwnerKey !== null) await assertBrowserInitializationReady(taskId);
  if (initial.logicalOwnerKey !== null && initial.status === 'CLOSED')
    throw new Error('Retired logical browser cannot resume');
  if (
    initial.controlState !== 'AGENT' &&
    (initial.controlLeaseExpiresAt === null || initial.controlLeaseExpiresAt.getTime() > Date.now())
  ) {
    throw new Error('Browser resume cannot replace a session under user control');
  }
  let sourceEnded = false;
  const resume = async () => {
    const current = await read();
    if (current.logicalOwnerKey !== null && current.status === 'CLOSED')
      throw new Error('Retired logical browser cannot resume');
    if (
      current.controlState !== 'AGENT' &&
      (current.controlLeaseExpiresAt === null ||
        current.controlLeaseExpiresAt.getTime() > Date.now())
    )
      throw new Error('Browser resume cannot replace a session under user control');
    if (current.logicalOwnerKey && current.sessionId && current.status === 'ACTIVE') {
      const health = await getBrowserSessionHealth(current.sessionId);
      if (health.sessionId !== current.sessionId)
        throw new Error('Browser resume health binding changed');
      sourceEnded = isConfirmedBrowserEnd(health.status);
      if (sourceEnded) await recordEndedLogicalBrowser(taskId, current.sessionId, health);
      else if (
        health.status !== null &&
        ['live', 'active', 'running'].includes(health.status.toLowerCase())
      )
        await withBrowserResumeClaim(taskId, (_assert, _native, mutate) =>
          checkpointLogicalBrowser(current.sessionId!, mutate)
        );
      else throw new Error('Browser resume liveness is unknown');
    }
    if (current.logicalOwnerKey) {
      await loadLogicalBrowserCheckpoint(taskId, current.sessionId !== null);
      await withBrowserResumeClaim(taskId, (_assert, _native, mutate) =>
        mutate(async (tx) => {
          const changed = await tx.browserSession.updateMany({
            where: {
              id: taskId,
              sessionId: current.sessionId,
              contextId: current.contextId,
              status: { in: ['ACTIVE', 'PAUSED'] },
              OR: [{ controlState: 'AGENT' }, { controlLeaseExpiresAt: { lte: new Date() } }],
            },
            data: { status: 'PAUSED' },
          });
          if (changed.count !== 1)
            throw new Error('Browser resume source ownership or control changed');
        })
      );
    }
    const forceFreshProfile = current.logicalOwnerKey ? true : options.forceFreshProfile;
    const replaceWith = async (carry: BrowserStateCarry) => {
      const result = await dependencies.resumeSession(taskId, {
        ...replacementOptions(carry),
        ...(forceFreshProfile !== undefined ? { forceFreshProfile } : {}),
      });
      return assembleResumeResponse(taskId, result, dependencies, carry.carriedState);
    };
    // Tilion kill switch off: the row resumes on Kernel, carrying its state like a rotation.
    return current.provider === 'tilion' && !tilionRotationAvailable()
      ? withTilionSwitchCarry(taskId, options, dependencies.tilionSessionLive, replaceWith)
      : replaceWith(options);
  };
  if (
    !initial.logicalOwnerKey &&
    initial.provider !== 'kernel' &&
    initial.provider !== 'browser-use'
  )
    return resume();
  return withBrowserResumeLifecycle(taskId, {
    readBinding: read,
    compatibility: options.forceFreshProfile ? 'fresh' : 'default',
    reuseCompleted: !options.forceFreshProfile,
    sourceEnded: () => sourceEnded,
    canFollow: async () => {
      const current = await read();
      if (current.sessionId === null) return false;
      const health = await getBrowserSessionHealth(current.sessionId);
      const live =
        health.status !== null &&
        ['active', 'live', 'running'].includes(health.status.toLowerCase());
      sourceEnded = isConfirmedBrowserEnd(health.status);
      if (!live && !sourceEnded) throw new Error('Browser resume liveness is unknown');
      return live && (health.ttlMs === null || health.ttlMs >= BROWSER_SESSION_MIN_REMAINING_MS);
    },
    resume,
    inspect: inspectResumeCandidate,
    ...failedHydrationCleanup(taskId, getBrowserSessionHealth),
    follow: async () => {
      const current = await read();
      if (
        current.controlState !== 'AGENT' &&
        (current.controlLeaseExpiresAt === null ||
          current.controlLeaseExpiresAt.getTime() > Date.now())
      ) {
        throw new Error('Browser resume cannot follow a session under user control');
      }
      if (current.sessionId === null || !current.wsUrl || !current.debugUrl)
        throw new Error('Ready browser binding is incomplete');
      return assembleResumeResponseWithTransport(
        taskId,
        {
          provider: storedBrowserProvider(current.provider),
          sessionId: current.sessionId,
          wsUrl: current.wsUrl,
          debugUrl: current.debugUrl,
          savedUrl: current.currentUrl ?? current.startUrl ?? undefined,
          proxySource: current.kernelProxySource ?? 'browser_use_residential_country',
          proxyLocation: DEFAULT_GEOLOCATION,
          profileId: current.providerProfileId,
          profileSource: current.providerProfileSource ?? 'session_bound',
        },
        dependencies,
        true
      );
    },
  });
}

type RecreatedSession = Awaited<ReturnType<typeof resumeSession>>;

/**
 * Build the full session-resume response (cookie/fingerprint re-injection,
 * passwords, passkeys, user settings) from a freshly recreated provider session.
 * Shared by resume and rotate_ip — both hand back an identical response shape,
 * including when rotate_ip crosses between provider-specific profiles.
 */
async function assembleResumeResponse(
  taskId: string,
  result: RecreatedSession,
  dependencies: BrowserSessionResumeDependencies,
  carriedState?: TilionCarriedState
) {
  // Tilion keeps the same browser and its worker-owned CDP connection.
  if (result.profileSource === 'tilion_rotated_in_place')
    return assembleResumeResponseWithTransport(taskId, result, dependencies, true);
  return withOwnedResumeTransport(result, async () => {
    const response = await assembleResumeResponseWithTransport(taskId, result, dependencies);
    await applyCarriedStateToReplacement(
      taskId,
      result,
      dependencies.restoreCarriedState ?? restoreTilionBrowserState,
      carriedState
    );
    return response;
  });
}

async function assembleResumeResponseWithTransport(
  taskId: string,
  result: RecreatedSession,
  dependencies: BrowserSessionResumeDependencies,
  readOnly = false
) {
  const session = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });

  let injectionResult: Pick<InjectionResult, 'cookies' | 'fingerprint'> = {
    cookies: {
      injected: false,
      cookieCount: 0,
      authSource: 'none' as const,
      credentialRef: null,
    },
    fingerprint: { injected: false },
  };
  let fingerprintInjection = null;
  let serializedPasswords: SerializedPassword[] = [];
  let serializedPasskeys: SerializedPasskey[] = [];
  let userSettings: UserSettings | null = null;
  const currentUrl = result.savedUrl ?? session?.currentUrl ?? null;
  const startUrl = session?.startUrl ?? null;
  const authRealm = canonicalAuthRealm(currentUrl ?? startUrl ?? '');

  if (!readOnly && browserResumeScope()) {
    if (
      session?.controlState !== 'AGENT' &&
      (session?.controlLeaseExpiresAt === null ||
        session?.controlLeaseExpiresAt === undefined ||
        session.controlLeaseExpiresAt.getTime() > Date.now())
    ) {
      throw new Error('Browser resume cannot hydrate a session under user control');
    }
    await browserResumeScope()?.beforeHydration(result.sessionId);
  }
  // An in-place exit rotation keeps the same browser (the worker holds its only CDP socket), so
  // there is no replacement to restore the checkpoint into and no transport to validate.
  const sameBrowser = result.ipRotation !== undefined;
  if (!readOnly && session?.logicalOwnerKey && !sameBrowser) {
    if (!result.validationBrowser)
      throw new Error('Logical browser restore requires validated transport');
    await restoreLogicalBrowserCheckpoint(taskId, result.validationBrowser);
  }
  if (session?.context.userId !== undefined) {
    if (
      !readOnly &&
      !session.logicalOwnerKey &&
      result.savedUrl !== undefined &&
      result.savedUrl !== ''
    ) {
      try {
        await browserResumeScope()?.assertOwned();
        injectionResult = await dependencies.injectUserData(
          result.sessionId,
          session.context.userId,
          result.savedUrl,
          result.validationBrowser ? { browser: result.validationBrowser } : undefined
        );
      } catch (error) {
        // The durable resume owner settles its failed candidate. Legacy resumes
        // close directly instead of returning a partially injected browser.
        if (browserResumeScope()) throw error;
        await dependencies.closeSession(result.sessionId, false).catch((closeError) => {
          // Never let cleanup mask the original injection failure.
          log.error('Failed to close browser session after injection failure', {
            taskId,
            sessionId: result.sessionId,
            error: closeError instanceof Error ? closeError.message : String(closeError),
          });
        });
        throw error;
      }
    }
    fingerprintInjection = await getFingerprintInjectionData(session.context.userId);
    const [passwords, passkeys, user] = await Promise.all([
      findPasswords(session.context.userId),
      authRealm !== '' ? reservePasskeysForRealm(session.context.userId, authRealm) : [],
      findUserSettings(session.context.userId),
    ]);
    serializedPasswords = serializePasswords(passwords);
    serializedPasskeys = serializePasskeys(passkeys);
    userSettings = toUserSettings(user);
  }

  const health = await getBrowserSessionHealth(result.sessionId).catch((error: unknown) => {
    log.warn('Could not inspect resumed browser health', {
      taskId,
      sessionId: result.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (health && health.sessionId !== result.sessionId)
    throw new Error('Resumed browser health binding changed');
  if (health && isConfirmedBrowserEnd(health.status))
    throw new Error('Resumed browser ended before readiness');

  if (!readOnly) await browserResumeScope()?.assertOwned();
  if (!readOnly && session?.logicalOwnerKey && !sameBrowser && !browserResumeScope()) {
    const ready = await prisma.browserSession.updateMany({
      where: { id: taskId, sessionId: result.sessionId, status: 'PAUSED' },
      data: { status: 'ACTIVE' },
    });
    if (ready.count !== 1) throw new Error('Logical browser lost readiness ownership');
  }

  return {
    task_id: taskId,
    session_id: result.sessionId,
    debug_url: result.debugUrl,
    ws_url: result.wsUrl,
    saved_url: result.savedUrl,
    start_url: startUrl,
    current_url: currentUrl,
    auth_realm: authRealm,
    status: 'ACTIVE' as const,
    browser_session_health: health,
    ...(health?.provider === 'steel' ? { steel_session_health: health } : {}),
    browser_session_metadata: {
      provider: result.provider,
      proxy_source: result.proxySource,
      proxy_location: result.proxyLocation ?? DEFAULT_GEOLOCATION,
      profile_id: result.profileId,
      profile_source: result.profileSource,
      ...(result.provider === 'steel'
        ? {
            steel_profile_id: result.profileId,
            steel_profile_source: result.profileSource,
          }
        : {}),
    },
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    auth_source: injectionResult.cookies.authSource,
    auth_credential_ref: injectionResult.cookies.credentialRef,
    fingerprint_injected: injectionResult.fingerprint.injected,
    fingerprint_injection: fingerprintInjection,
    passwords: serializedPasswords,
    passkeys: serializedPasskeys,
    user_settings: userSettings,
  };
}

/**
 * rotate_ip tool backend. Atomically advances the per-run rotation counter (keyed
 * to the stable BrowserSession row id), enforces the cap, selects the tier
 * (Kernel residential -> Kernel mobile -> Steel residential -> Browser Use residential;
 * Tilion residential -> Tilion mobile -> Kernel residential -> Steel residential),
 * recreates the session, and returns the resume-shaped response plus escalation
 * state the agent reasons over. Provider choice is server-owned, not model-owned.
 */
export async function rotateBrowserProxy(
  taskId: string,
  userId?: string,
  currentUrl?: string,
  carry: BrowserStateCarry = {},
  dependencies: BrowserSessionResumeDependencies = defaultResumeDependencies
) {
  // Reserve one rotation atomically. UPDATE ... RETURNING both enforces the cap
  // under concurrent calls and returns the exact ladder position this request
  // reserved. User calls also constrain the write to their BrowserContext; an
  // ownership mismatch deliberately looks the same as a missing task.
  const ownerUserId = userId ?? null;
  const reserved = await prisma.$queryRaw<Array<{ proxyRotationCount: number; provider: string }>>`
    UPDATE "BrowserSession"
       SET "proxyRotationCount" = "proxyRotationCount" + 1,
           "currentUrl" = COALESCE(${currentUrl ?? null}::text, "currentUrl")
     WHERE "id" = ${taskId}
       AND "proxyRotationCount" < ${ROTATION_CAP}
       AND (
         ${ownerUserId}::text IS NULL
         OR EXISTS (
           SELECT 1
             FROM "BrowserContext"
            WHERE "BrowserContext"."id" = "BrowserSession"."contextId"
              AND "BrowserContext"."userId" = ${ownerUserId}
         )
       )
    RETURNING "proxyRotationCount", "provider"
  `;

  const rotationsUsed = reserved[0]?.proxyRotationCount;
  if (rotationsUsed === undefined) {
    const session = await prisma.browserSession.findFirst({
      where: {
        id: taskId,
        ...(userId === undefined ? {} : { context: { userId } }),
      },
      select: { proxyRotationCount: true },
    });
    if (session === null) throw new RotationSessionNotFoundError(taskId);
    throw new ProxyRotationExhaustedError(ROTATION_CAP);
  }

  const currentProvider = storedBrowserProvider(reserved[0]!.provider);
  const ladderStep = selectRotationStep(
    rotationsUsed,
    currentProvider,
    browserUseEnabled(),
    tilionRotationAvailable()
  );
  const providerLocked = recoverySameProviderOnly();
  const availability = { browserUse: browserUseEnabled(), tilion: tilionRotationAvailable() };
  const lockedStep = providerLocked
    ? sameProviderRotationStep(ladderStep, currentProvider, availability)
    : ladderStep;
  if (providerLocked) {
    log.info(
      `recovery provider-locked (BROWSER_RECOVERY_SAME_PROVIDER_ONLY): ladder ${rotationStepLabel(ladderStep)} -> ${
        lockedStep ? rotationStepLabel(lockedStep) : 'no_same_provider_rung_left'
      }`,
      { taskId, rotationsUsed, currentProvider }
    );
  }
  if (lockedStep === null) {
    await prisma.browserSession.updateMany({
      where: { id: taskId, proxyRotationCount: { gt: 0 } },
      data: { proxyRotationCount: { decrement: 1 } },
    });
    throw new SameProviderRotationExhaustedError(currentProvider, rotationsUsed);
  }
  const step = lockedStep;

  log.info('Executing browser recovery rotation', {
    taskId,
    rotationsUsed,
    currentProvider,
    targetProvider: step.provider,
    proxyType: step.proxyType,
    recoveryAction: step.recoveryAction,
  });

  const captchaTelemetryBeforeRotation = await withTimeout(
    dependencies.getBrowserCaptchaTelemetry(taskId),
    3_000
  ).catch((error) => {
    log.warn('Failed to read CAPTCHA telemetry before browser rotation', {
      taskId,
      currentProvider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  log.info('Captured CAPTCHA telemetry before browser rotation', {
    taskId,
    currentProvider,
    captchaTelemetry: captchaTelemetryBeforeRotation,
  });

  let result: Awaited<ReturnType<typeof rotateProxy>>;
  let rotationFallbackReason: string | null = null;
  let effectiveCarry = carry;
  let carryFromPausedState = false;
  const prepareSwitchOffTilion = async (target: RotationStep) => {
    if (currentProvider !== 'tilion' || target.provider === 'tilion') return;
    const prepared = await carryForTilionSwitch(
      taskId,
      effectiveCarry,
      dependencies.tilionSessionLive
    );
    effectiveCarry = prepared.carry;
    carryFromPausedState = carryFromPausedState || prepared.fromPausedState;
  };
  try {
    try {
      await prepareSwitchOffTilion(step);
      result = await dependencies.rotateProxy(taskId, step, replacementOptions(effectiveCarry));
    } catch (error) {
      // Tilion could not serve this exit (e.g. mobile: 409 proxy_type_unavailable).
      // The reserved rotation still owes the agent a new IP: take the next rung now.
      if (step.provider !== 'tilion' || !isTilionExitUnavailableError(error)) throw error;
      const ladderFallback = rungAfterTilionUnavailable(rotationsUsed, browserUseEnabled());
      // Provider-locked: a Tilion exit that cannot be served falls back to a Tilion
      // residential replacement, never another provider; none left -> typed result.
      const fallback = providerLocked
        ? step.proxyType === 'residential'
          ? null
          : sameProviderRotationStep(ladderFallback, 'tilion', availability)
        : ladderFallback;
      if (fallback === null) throw new SameProviderRotationExhaustedError('tilion', rotationsUsed);
      rotationFallbackReason = `tilion_${step.proxyType}_unavailable: ${
        error instanceof Error ? error.message.slice(0, 200) : String(error)
      }`;
      log.warn('Tilion exit unavailable; advancing the rotation ladder', {
        taskId,
        rotationsUsed,
        from: rotationStepLabel(step),
        to: rotationStepLabel(fallback),
        reason: rotationFallbackReason,
      });
      await prepareSwitchOffTilion(fallback);
      result = await dependencies.rotateProxy(taskId, fallback, replacementOptions(effectiveCarry));
    }
  } catch (error) {
    // A transient provider failure did not deliver a new IP, so return its
    // reservation to the shared budget. The decrement is atomic and composes
    // with concurrent successful or failed reservations.
    await prisma.browserSession.updateMany({
      where: { id: taskId, proxyRotationCount: { gt: 0 } },
      data: { proxyRotationCount: { decrement: 1 } },
    });
    throw error;
  }
  const response = await assembleResumeResponse(
    taskId,
    result,
    dependencies,
    effectiveCarry.carriedState
  );
  // The paused snapshot belonged to the replaced Tilion session; it is consumed.
  if (carryFromPausedState) await clearPausedState({ taskId });
  const rotationsRemaining = ROTATION_CAP - rotationsUsed;
  const effectiveStep: RotationStep = {
    provider: result.provider === 'local' ? 'steel' : result.provider,
    proxyType: result.proxyType,
    recoveryAction: result.recoveryAction,
  };
  const nextRecovery =
    rotationsRemaining === 0
      ? 'rotation_budget_exhausted'
      : nextRecoveryLabel(
          rotationsUsed + 1,
          result.provider === 'local' ? 'steel' : result.provider,
          providerLocked,
          availability
        );

  return {
    ...response,
    provider: effectiveStep.provider,
    previous_provider: result.previousProvider,
    recovery_action: effectiveStep.recoveryAction,
    proxy_tier: effectiveStep.proxyType,
    rotations_used: rotationsUsed,
    rotations_remaining: rotationsRemaining,
    rotation_fallback_reason: rotationFallbackReason,
    next_recovery: nextRecovery,
    rotation_message: buildRotationMessage(
      effectiveStep,
      rotationsUsed,
      rotationsRemaining,
      result.previousProvider
    ),
    captcha_telemetry_before_rotation: captchaTelemetryBeforeRotation,
    // Steel exposes an in-flight flag. Kernel currently exposes terminal
    // outcomes only, so preserve unknown as null instead of reporting false.
    rotation_interrupted_captcha_solver: captchaTelemetryBeforeRotation?.isSolving ?? null,
  };
}
/* c8 ignore stop */
