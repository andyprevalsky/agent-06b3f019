/* c8 ignore start -- resumeBrowserSession requires Steel SDK */
import { prisma } from './database';
import { DEFAULT_GEOLOCATION } from './geoip';
import { createLogger } from './logger';
import { getFingerprintInjectionData } from './steel/files';
import { injectUserData } from './steel/injection';
import { resumeSession as steelResumeSession } from './steel/session';

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

export async function resumeBrowserSession(taskId: string) {
  log.info('Resuming browser task', { taskId });

  const result = await steelResumeSession(taskId);
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
  let userSettings: UserSettings | null = null;

  if (session?.context.userId !== undefined) {
    if (result.savedUrl !== undefined && result.savedUrl !== '') {
      injectionResult = await injectUserData(
        result.sessionId,
        session.context.userId,
        result.savedUrl
      );
    }
    fingerprintInjection = await getFingerprintInjectionData(session.context.userId);
    const [passwords, user] = await Promise.all([
      findPasswords(session.context.userId),
      findUserSettings(session.context.userId),
    ]);
    serializedPasswords = serializePasswords(passwords);
    userSettings = toUserSettings(user);
  }

  return {
    task_id: taskId,
    session_id: result.sessionId,
    debug_url: result.debugUrl,
    ws_url: result.wsUrl,
    saved_url: result.savedUrl,
    status: 'ACTIVE' as const,
    browser_session_metadata: {
      provider: result.sessionId.startsWith('local-') ? 'local' : 'steel',
      proxy_source: result.proxySource,
      proxy_location: result.proxyLocation ?? DEFAULT_GEOLOCATION,
      steel_profile_id: result.steelProfileId,
      steel_profile_source: result.profileSource,
    },
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    auth_source: injectionResult.cookies.authSource,
    auth_credential_ref: injectionResult.cookies.credentialRef,
    fingerprint_injected: injectionResult.fingerprint.injected,
    fingerprint_injection: fingerprintInjection,
    passwords: serializedPasswords,
    user_settings: userSettings,
  };
}
/* c8 ignore stop */
