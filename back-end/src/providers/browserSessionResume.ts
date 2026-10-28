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
import { connectValidatedBrowser } from './steel/sessionConnection';
import { assertBrowserInitializationReady } from './browser/initialization';
import {
  browserResumeScope,
  withBrowserResumeClaim,
  withBrowserResumeLifecycle,
} from './steel/lifecycleClaim';
import { inspectResumeCandidate } from './browser/resumeRecovery';
import {
  withOwnedResumeTransport,
  withAcknowledgedResumeTransport,
} from './browser/resumeTransport';
import { iphoneCapability } from './phoneAccountPolicy';
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
  ROTATION_CAP,
  rotationStepLabel,
  selectRotationStep,
  type RotationStep,
} from './browser/rotation';
import { storedBrowserProvider } from './browser/types';
import { browserUseEnabled } from './browser/config';

export class ProxyRotationExhaustedError extends Error {
  constructor(public readonly cap: number) {
    super(
      `PROXY_ROTATION_EXHAUSTED: rotated ${cap} times and the target is still blocking ` +
        `our proxy pool for this session. Do not rotate again — try a different approach ` +
        `or report the target as unreachable.`
    );
    this.name = 'ProxyRotationExhaustedError';
  }
}

export class RotationSessionNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Browser task not found: ${taskId}`);
    this.name = 'RotationSessionNotFoundError';
  }
}

const log = createLogger('BrowserSessionResume');

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

type SettingsAccount = UserSettings & { userId: string; isAnonymous: boolean };
function toUserSettings(user: SettingsAccount | null): UserSettings | null {
  if (user === null) return null;
  const { userId, isAnonymous, ...settings } = user;
  return { ...settings, ...iphoneCapability({ userId, isAnonymous, phone: user.phone }) };
}

async function findUserSettings(userId: string): Promise<SettingsAccount | null> {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      isAnonymous: true,
      name: true,
      email: true,
      phone: true,
      deliveryRecipientName: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      encryptedPaymentInformation: true,
      systemName: true,
      profilePicture: true,
      customSystemPrompt: true,
    },
  });
}

async function findPasswords(userId: string) {
  return prisma.browserPassword.findMany({
    where: { userId, disabledAt: null },
    select: {
      id: true,
      origin: true,
      username: true,
      encryptedPassword: true,
      dateLastUsed: true,
    },
    orderBy: { dateLastUsed: 'desc' },
  });
}

const PASSKEY_SIGNCOUNT_RESERVE_BLOCK = 100n;

async function reservePasskeysForRealm(userId: string, authRealm: string) {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      credentialId: string;
      encryptedPrivateKey: string;
      rpId: string;
      userHandle: string | null;
      base: bigint;
    }>
  >`
    UPDATE "PasskeyCredential"
    SET "signCount" = "signCount" + ${PASSKEY_SIGNCOUNT_RESERVE_BLOCK}
    WHERE "userId" = ${userId}
      AND "authRealm" = ${authRealm}
      AND "disabledAt" IS NULL
    RETURNING id, "credentialId", "encryptedPrivateKey", "rpId", "userHandle",
              ("signCount" - ${PASSKEY_SIGNCOUNT_RESERVE_BLOCK}) AS base
  `;
  return rows.map((r) => ({
    id: r.id,
    credentialId: r.credentialId,
    encryptedPrivateKey: r.encryptedPrivateKey,
    rpId: r.rpId,
    userHandle: r.userHandle,
    signCount: Number(r.base),
  }));
}

export async function resumeBrowserSession(
  taskId: string,
  options: { forceFreshProfile?: boolean } = {}
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
    ) {
      throw new Error('Browser resume cannot replace a session under user control');
    }
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
    const result = await resumeSession(taskId, {
      ...options,
      forceFreshProfile: current.logicalOwnerKey ? true : options.forceFreshProfile,
      keepValidationConnection: true,
    });
    return assembleResumeResponse(taskId, result);
  };
  if (
    !initial.logicalOwnerKey &&
    initial.provider !== 'kernel' &&
    initial.provider !== 'browser-use'
  )
    return resume();
  return withBrowserResumeLifecycle(taskId, {
    readBinding: read,
    retryHydration: initial.logicalOwnerKey
      ? async (nativeId, targets) => {
          const current = await read();
          if (
            (current.controlState !== 'AGENT' &&
              (!current.controlLeaseExpiresAt ||
                current.controlLeaseExpiresAt.getTime() > Date.now())) ||
            current.sessionId !== nativeId ||
            current.status !== 'PAUSED' ||
            !current.wsUrl ||
            !current.debugUrl
          )
            throw new Error('Acknowledged browser hydration transport changed');
          await browserResumeScope()!.assertOwned();
          const browser = await connectValidatedBrowser(current.wsUrl);
          if (!browser) throw new Error('Acknowledged browser hydration connection failed');
          return assembleResumeResponse(
            taskId,
            {
              provider: storedBrowserProvider(current.provider),
              sessionId: nativeId,
              wsUrl: current.wsUrl,
              debugUrl: current.debugUrl,
              savedUrl: current.currentUrl ?? current.startUrl ?? undefined,
              proxySource: current.kernelProxySource ?? 'browser_use_residential_country',
              proxyLocation: DEFAULT_GEOLOCATION,
              profileId: current.providerProfileId,
              profileSource: current.providerProfileSource ?? 'session_bound',
              validationBrowser: browser,
            },
            targets
          );
        }
      : undefined,
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
  recoveryTargets?: Array<{ targetId: string; urlHash: string }>
) {
  return withAcknowledgedResumeTransport(
    result,
    () => assembleResumeResponseWithTransport(taskId, result, false, recoveryTargets),
    () => browserResumeScope()?.hydrationTransportClosed()
  );
}

async function assembleResumeResponseWithTransport(
  taskId: string,
  result: RecreatedSession,
  readOnly = false,
  recoveryTargets?: Array<{ targetId: string; urlHash: string }>
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
    await restoreLogicalBrowserCheckpoint(taskId, result.validationBrowser, {
      targets: recoveryTargets,
      assertOwned: recoveryTargets ? browserResumeScope()?.assertHydrationOwned : undefined,
      prepared: browserResumeScope()?.recordHydrationTargets,
    });
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
        injectionResult = await injectUserData(
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
        await closeSession(result.sessionId, false).catch((closeError) => {
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
  if (!readOnly && session?.logicalOwnerKey && !browserResumeScope()) {
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

function buildRotationMessage(step: RotationStep, used: number, remaining: number): string {
  const left = `${remaining} rotation${remaining === 1 ? '' : 's'} remaining.`;
  if (step.recoveryAction === 'provider_switched' && step.provider === 'browser-use') {
    return `Switched to Browser Use with a new country-level residential proxy session (${used}/${ROTATION_CAP}). Login and cookies preserved. ${left}`;
  }
  if (step.recoveryAction === 'provider_switched') {
    return (
      `Switched from Kernel to Steel with a fresh Steel residential IP ` +
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
  if (step.proxyType === 'mobile') {
    return (
      `Rotated to a fresh Kernel mobile-carrier IP (${used}/${ROTATION_CAP}) — same region. ` +
      `Login and cookies preserved. ${left}`
    );
  }
  return (
    `Rotated to a fresh Kernel residential IP (${used}/${ROTATION_CAP}) — same region, ` +
    `login and cookies preserved. ${left}`
  );
}

/**
 * rotate_ip tool backend. Atomically advances the per-run rotation counter (keyed
 * to the stable BrowserSession row id), enforces the cap, selects the tier
 * (Kernel residential -> Kernel mobile -> Steel residential -> Browser Use residential),
 * recreates the session, and returns the resume-shaped response plus escalation
 * state the agent reasons over. Provider choice is server-owned, not model-owned.
 */
export async function rotateBrowserProxy(taskId: string, userId?: string, currentUrl?: string) {
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
  const step = selectRotationStep(rotationsUsed, currentProvider, browserUseEnabled());

  log.info('Executing browser recovery rotation', {
    taskId,
    rotationsUsed,
    currentProvider,
    targetProvider: step.provider,
    proxyType: step.proxyType,
    recoveryAction: step.recoveryAction,
  });

  const captchaTelemetryBeforeRotation = await withTimeout(
    getBrowserCaptchaTelemetry(taskId),
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
  try {
    result = await rotateProxy(taskId, step, {
      keepValidationConnection: true,
    });
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
  const response = await assembleResumeResponse(taskId, result);
  const rotationsRemaining = ROTATION_CAP - rotationsUsed;
  const effectiveStep: RotationStep = {
    provider: result.provider === 'local' ? 'steel' : result.provider,
    proxyType: result.proxyType,
    recoveryAction: result.recoveryAction,
  };
  const nextRecovery =
    rotationsRemaining === 0
      ? 'rotation_budget_exhausted'
      : rotationStepLabel(
          selectRotationStep(
            rotationsUsed + 1,
            result.provider === 'local' ? 'steel' : result.provider,
            browserUseEnabled()
          )
        );

  return {
    ...response,
    provider: effectiveStep.provider,
    previous_provider: result.previousProvider,
    recovery_action: effectiveStep.recoveryAction,
    proxy_tier: effectiveStep.proxyType,
    rotations_used: rotationsUsed,
    rotations_remaining: rotationsRemaining,
    next_recovery: nextRecovery,
    rotation_message: buildRotationMessage(effectiveStep, rotationsUsed, rotationsRemaining),
    captcha_telemetry_before_rotation: captchaTelemetryBeforeRotation,
    // Steel exposes an in-flight flag. Kernel currently exposes terminal
    // outcomes only, so preserve unknown as null instead of reporting false.
    rotation_interrupted_captcha_solver: captchaTelemetryBeforeRotation?.isSolving ?? null,
  };
}
/* c8 ignore stop */
