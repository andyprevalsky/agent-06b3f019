import { restoreLogicalBrowserCheckpoint } from './browser/checkpoint';
import { browserResumeScope, withBrowserResumeLifecycle } from './steel/lifecycleClaim';
import { inspectResumeCandidate } from './browser/resumeRecovery';
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
import { carryForTilionSwitch, withTilionSwitchCarry } from './browserSwitchCarry';
import { storedBrowserProvider } from './browser/types';
import { browserProviderEnabled, browserUseEnabled } from './browser/config';

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

const PROVIDER_DISPLAY_NAMES: Record<RotationStep['provider'], string> = {
  kernel: 'Kernel',
  steel: 'Steel',
  'browser-use': 'Browser Use',
  tilion: 'Tilion',
};

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

export type {
  SerializedPasskey,
  SerializedPassword,
  UserSettings,
} from './browserSessionResumeCredentials';
import {
  findPasswords,
  findUserSettings,
  reservePasskeysForRealm,
  serializePasskeys,
  serializePasswords,
  toUserSettings,
  type SerializedPasskey,
  type SerializedPassword,
  type UserSettings,
} from './browserSessionResumeCredentials';

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
  const initial = await read();
  if (initial.logicalOwnerKey !== null && initial.status === 'CLOSED')
    throw new Error('Retired logical browser cannot resume');
  if (initial.logicalOwnerKey !== null && initial.provider === 'steel')
    throw new Error('Logical Steel browser restore requires durable hydration custody');
  if (
    initial.controlState !== 'AGENT' &&
    (initial.controlLeaseExpiresAt === null || initial.controlLeaseExpiresAt.getTime() > Date.now())
  ) {
    throw new Error('Browser resume cannot replace a session under user control');
  }
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
  if (initial.provider !== 'kernel' && initial.provider !== 'browser-use') return resume();
  let sourceEnded = false;
  return withBrowserResumeLifecycle(taskId, {
    readBinding: read,
    compatibility: options.forceFreshProfile ? 'fresh' : 'default',
    reuseCompleted: !options.forceFreshProfile,
    sourceEnded: () => sourceEnded,
    canFollow: async () => {
      const current = await read();
      if (current.sessionId === null) return false;
      const health = await getBrowserSessionHealth(current.sessionId);
      if (health.status === null) throw new Error('Browser resume liveness is unknown');
      sourceEnded = !['active', 'live', 'running'].includes(health.status.toLowerCase());
      return (
        ['active', 'live', 'running'].includes(health.status.toLowerCase()) &&
        (health.ttlMs === null || health.ttlMs > 60_000)
      );
    },
    resume,
    inspect: inspectResumeCandidate,
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
  return withOwnedResumeTransport(result, async () => {
    const response = await assembleResumeResponseWithTransport(taskId, result, dependencies);
    await applyCarriedStateToReplacement(taskId, result, dependencies, carriedState);
    return response;
  });
}

/**
 * The worker captured the live Tilion session's state (cookies, localStorage,
 * IndexedDB) because the backend cannot connect to it. A Tilion replacement
 * consumes it inside the Tilion adapter; a switch to another provider (Kernel,
 * Steel) must write it here, after the DB state, since it is the fresher copy,
 * then return the tab to the saved URL. Best effort: a failed restore never
 * fails the rotation, but it is logged.
 */
async function applyCarriedStateToReplacement(
  taskId: string,
  result: RecreatedSession,
  dependencies: BrowserSessionResumeDependencies,
  carriedState: TilionCarriedState | undefined
): Promise<void> {
  if (carriedState === undefined || result.provider === 'tilion') return;
  const browser = result.validationBrowser;
  if (browser === undefined) {
    log.warn('Carried browser state not restored: replacement has no validation client', {
      taskId,
      provider: result.provider,
    });
    return;
  }
  try {
    const restore = dependencies.restoreCarriedState ?? restoreTilionBrowserState;
    const restored = await restore(browser, carriedState);
    const savedUrl = result.savedUrl;
    // Restoring origins navigated the tab through them; put it back where the agent was.
    if (restored.origins > 0 && savedUrl !== undefined && savedUrl !== '') {
      await browser
        .contexts()[0]
        ?.pages()[0]
        ?.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    }
    log.info('Carried browser state restored into the replacement', {
      taskId,
      provider: result.provider,
      cookies: restored.cookies,
      origins: restored.origins,
    });
  } catch (error) {
    log.warn('Carried browser state restore failed', {
      taskId,
      provider: result.provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  if (!readOnly && session?.logicalOwnerKey) {
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
        // `injectUserData` deliberately REJECTS on a state-injection timeout
        // rather than resuming with partial state. `resumeSession` already
        // created a fresh remote browser by this point, so letting the error
        // propagate untouched leaks a paid session that nothing will ever
        // close — the caller only sees the exception, never the session id.
        // Close it (not pause: the resume failed, so there is no state worth
        // preserving) before rethrowing.
        // Durable resume custody must retain an ambiguous hydration outcome.
        // Only the older non-custodied path can safely use eager cleanup here.
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

  if (!readOnly) await browserResumeScope()?.assertOwned();
  if (!readOnly && session?.logicalOwnerKey) {
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

export function buildRotationMessage(
  step: RotationStep,
  used: number,
  remaining: number,
  previousProvider?: RotationStep['provider'] | 'local'
): string {
  const left = `${remaining} rotation${remaining === 1 ? '' : 's'} remaining.`;
  if (step.recoveryAction === 'provider_switched' && step.provider === 'browser-use') {
    return `Switched to Browser Use with a new country-level residential proxy session (${used}/${ROTATION_CAP}). Login and cookies preserved. ${left}`;
  }
  if (step.recoveryAction === 'provider_switched') {
    const from =
      previousProvider === undefined || previousProvider === 'local'
        ? 'Kernel'
        : PROVIDER_DISPLAY_NAMES[previousProvider];
    const to = PROVIDER_DISPLAY_NAMES[step.provider];
    const tier = step.proxyType === 'mobile' ? 'mobile-carrier' : step.proxyType;
    return (
      `Switched from ${from} to ${to} with a fresh ${to} ${tier} IP ` +
      `(${used}/${ROTATION_CAP}) — browser and proxy infrastructure changed, same region. ` +
      `Login and cookies preserved. ${left}`
    );
  }
  if (step.provider === 'steel') {
    return (
      `Rotated to another fresh Steel residential IP (${used}/${ROTATION_CAP}) — same region, ` +
      `login and cookies preserved. ${left}`
    );
  }
  if (step.provider === 'browser-use') {
    return `Started a new Browser Use residential proxy session (${used}/${ROTATION_CAP}) in the same country. Login and cookies preserved. ${left}`;
  }
  const provider = PROVIDER_DISPLAY_NAMES[step.provider];
  if (step.proxyType === 'mobile') {
    return (
      `Rotated to a fresh ${provider} mobile-carrier IP (${used}/${ROTATION_CAP}) — same region. ` +
      `Login and cookies preserved. ${left}`
    );
  }
  return (
    `Rotated to a fresh ${provider} residential IP (${used}/${ROTATION_CAP}) — same region, ` +
    `login and cookies preserved. ${left}`
  );
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
