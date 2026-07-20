/* c8 ignore start -- resumeBrowserSession requires Steel SDK */
import { prisma } from './database';
import { DEFAULT_GEOLOCATION } from './geoip';
import { createLogger } from './logger';
import { canonicalAuthRealm } from './authRealm';
import { getFingerprintInjectionData, injectUserData, resumeSession, rotateProxy } from './browser';
import { browserProviderEnabled } from './browser/config';
import type { KernelProxyType } from './browser/kernelProxy';

// rotate_ip escalation ladder (see docs/plans/active/rotate-ip-tool.md):
// calls 1-2 → fresh residential IP, calls 3-4 → mobile carrier IP, then exhausted.
export const ROTATION_CAP = 4;
export const RESIDENTIAL_ROTATIONS = 2;

/**
 * Escalation tier for the Nth rotation of a run. Calls 1..RESIDENTIAL_ROTATIONS
 * stay residential; later calls escalate to mobile when it's enabled, otherwise
 * remain residential (still a fresh exit IP, just not carrier-grade). Pure so the
 * ladder is unit-testable without a DB or the Kernel SDK.
 */
export function selectRotationTier(rotationsUsed: number, mobileEnabled: boolean): KernelProxyType {
  return rotationsUsed > RESIDENTIAL_ROTATIONS && mobileEnabled ? 'mobile' : 'residential';
}

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

type InjectionResult = Awaited<ReturnType<typeof injectUserData>>;

interface SerializedPassword {
  id: string;
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsed: number | null;
}

interface UserSettings {
  name: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  encryptedPaymentInformation: string | null;
  systemName: string | null;
  profilePicture: string | null;
  customSystemPrompt: string | null;
}

interface SerializedPasskey {
  id: string;
  credentialId: string;
  encryptedPrivateKey: string;
  rpId: string;
  userHandle: string | null;
  signCount: number;
}

function serializePasswords(
  passwords: Array<{
    id: string;
    origin: string;
    username: string;
    encryptedPassword: string;
    dateLastUsed: bigint | null;
  }>
): SerializedPassword[] {
  return passwords.map((password) => ({
    id: password.id,
    origin: password.origin,
    username: password.username,
    encryptedPassword: password.encryptedPassword,
    dateLastUsed: password.dateLastUsed !== null ? Number(password.dateLastUsed) : null,
  }));
}

function serializePasskeys(
  passkeys: Array<{
    id: string;
    credentialId: string;
    encryptedPrivateKey: string;
    rpId: string;
    userHandle: string | null;
    signCount: number;
  }>
): SerializedPasskey[] {
  return passkeys.map((p) => ({
    id: p.id,
    credentialId: p.credentialId,
    encryptedPrivateKey: p.encryptedPrivateKey,
    rpId: p.rpId,
    userHandle: p.userHandle,
    signCount: p.signCount,
  }));
}

function toUserSettings(user: UserSettings | null): UserSettings | null {
  return user;
}

async function findUserSettings(userId: string): Promise<UserSettings | null> {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      name: true,
      phone: true,
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

export async function resumeBrowserSession(taskId: string) {
  log.info('Resuming browser task', { taskId });

  const result = await resumeSession(taskId);
  return assembleResumeResponse(taskId, result);
}

type RecreatedSession = Awaited<ReturnType<typeof resumeSession>>;

/**
 * Build the full session-resume response (cookie/fingerprint re-injection,
 * passwords, passkeys, user settings) from a freshly recreated provider session.
 * Shared by resume and rotate_ip — both hand back an identical browser session
 * on the same profile, differing only in the proxy behind it.
 */
async function assembleResumeResponse(taskId: string, result: RecreatedSession) {
  const session = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });

  let injectionResult: Pick<InjectionResult, 'cookies' | 'fingerprint'> = {
    cookies: { injected: false, cookieCount: 0, authSource: 'none' as const, credentialRef: null },
    fingerprint: { injected: false },
  };
  let fingerprintInjection = null;
  let serializedPasswords: SerializedPassword[] = [];
  let serializedPasskeys: SerializedPasskey[] = [];
  let userSettings: UserSettings | null = null;
  const currentUrl = result.savedUrl ?? session?.currentUrl ?? null;
  const startUrl = session?.startUrl ?? null;
  const authRealm = canonicalAuthRealm(currentUrl ?? startUrl ?? '');

  if (session?.context.userId !== undefined) {
    if (result.savedUrl !== undefined && result.savedUrl !== '') {
      injectionResult = await injectUserData(
        result.sessionId,
        session.context.userId,
        result.savedUrl
      );
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

function buildRotationMessage(tier: KernelProxyType, used: number, remaining: number): string {
  const left = `${remaining} rotation${remaining === 1 ? '' : 's'} remaining.`;
  if (tier === 'mobile') {
    return (
      `Escalated to a mobile-carrier IP (${used}/${ROTATION_CAP}) — the strongest, ` +
      `hardest-to-block tier, same region. Login and cookies preserved. ${left}`
    );
  }
  return (
    `Rotated to a fresh residential IP (${used}/${ROTATION_CAP}) — same region, ` +
    `login and cookies preserved. ${left}`
  );
}

/**
 * rotate_ip tool backend. Atomically advances the per-run rotation counter (keyed
 * to the stable BrowserSession row id), enforces the cap, selects the tier
 * (1-2 residential, 3-4 mobile when KERNEL_MOBILE_FALLBACK_ENABLED), recreates the
 * session on that proxy, and returns the resume-shaped response plus escalation
 * state the agent reasons over.
 */
export async function rotateBrowserProxy(taskId: string) {
  // Atomic read-check-increment so the cap holds under concurrent calls / retries.
  const rotationsUsed = await prisma.$transaction(async (tx) => {
    const s = await tx.browserSession.findUnique({
      where: { id: taskId },
      select: { proxyRotationCount: true },
    });
    if (s === null) throw new RotationSessionNotFoundError(taskId);
    if (s.proxyRotationCount >= ROTATION_CAP) throw new ProxyRotationExhaustedError(ROTATION_CAP);
    const updated = await tx.browserSession.update({
      where: { id: taskId },
      data: { proxyRotationCount: { increment: 1 } },
      select: { proxyRotationCount: true },
    });
    return updated.proxyRotationCount;
  });

  // Calls 1-2 → residential; 3-4 → mobile (gated). When mobile is disabled the
  // later rotations stay residential — still a fresh exit IP, just not carrier.
  const mobileEnabled = browserProviderEnabled('KERNEL_MOBILE_FALLBACK_ENABLED', false);
  const proxyType = selectRotationTier(rotationsUsed, mobileEnabled);

  log.info('Rotating browser proxy', { taskId, rotationsUsed, proxyType, mobileEnabled });

  const result = await rotateProxy(taskId, proxyType);
  const response = await assembleResumeResponse(taskId, result);
  const rotationsRemaining = ROTATION_CAP - rotationsUsed;

  return {
    ...response,
    proxy_tier: proxyType,
    rotations_used: rotationsUsed,
    rotations_remaining: rotationsRemaining,
    rotation_message: buildRotationMessage(proxyType, rotationsUsed, rotationsRemaining),
  };
}
/* c8 ignore stop */
