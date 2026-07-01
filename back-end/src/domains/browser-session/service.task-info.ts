import { getFingerprintInjectionData, getSteelSessionHealth } from '../../providers/steel';
import { createLogger } from '../../providers/logger';
import { canonicalAuthRealm } from '../../providers/authRealm';
import * as repo from './repo';
import { serializePasskeys, serializePasswords, toUserSettings } from './service.serializers';

const log = createLogger('BrowserSession');

type TaskInfoResponse = {
  task_id: string;
  session_id: string;
  debug_url: string | null;
  ws_url: string | null;
  status: string;
  start_url: string | null;
  current_url: string | null;
  auth_realm: string;
  fingerprint_injection: unknown;
  passwords: ReturnType<typeof serializePasswords>;
  passkeys: ReturnType<typeof serializePasskeys>;
  user_settings: ReturnType<typeof toUserSettings>;
  browser_session_metadata: {
    provider: string;
    steel_profile_id: string | null;
  };
  same_session_available?: boolean;
  same_session_unavailable_reason?: string;
  steel_session_health?: Awaited<ReturnType<typeof getSteelSessionHealth>>;
};

function isLiveSteelStatus(status: string | null): boolean {
  if (status === null) return false;
  return ['live', 'active', 'running'].includes(status.toLowerCase());
}

export async function getTaskOwnerUserId(taskId: string): Promise<string | undefined> {
  const session = await repo.findSessionByTaskId(taskId);
  return session?.context?.userId ?? undefined;
}

async function collectUserInjectionData(
  userId: string | null | undefined,
  authRealm: string,
  taskId: string
) {
  let fingerprintInjection = null;
  let passwords: ReturnType<typeof serializePasswords> = [];
  let passkeys: ReturnType<typeof serializePasskeys> = [];
  let userSettings: ReturnType<typeof toUserSettings> = null;

  if (userId !== null && userId !== undefined) {
    fingerprintInjection = await getFingerprintInjectionData(userId);

    /*
     * Resume credential flow:
     *
     * BrowserSession(currentUrl/startUrl)
     *   -> canonical auth realm
     *   -> reserve passkey counter block
     *   -> task-info response
     *   -> agent re-seeds CDP virtual authenticator
     *
     * Virtual authenticator credentials are scoped to the live CDP setup, so a
     * resumed browser-agent span needs the same passkey material as initSession.
     */
    const [user, storedPasswords, storedPasskeys] = await Promise.all([
      repo.findUserSettings(userId),
      repo.findPasswords(userId),
      authRealm !== '' ? repo.reservePasskeysForRealm(userId, authRealm) : [],
    ]);
    userSettings = toUserSettings(user);
    passwords = serializePasswords(storedPasswords);
    passkeys = serializePasskeys(storedPasskeys);

    if (passkeys.length > 0) {
      log.info('Including passkeys in task response', {
        count: passkeys.length,
        realm: authRealm,
        taskId,
      });
    }
  }

  return { fingerprintInjection, passwords, passkeys, userSettings };
}

function buildTaskInfoResponse(
  session: NonNullable<Awaited<ReturnType<typeof repo.findSessionByTaskId>>>,
  currentUrl: string | null,
  startUrl: string | null,
  authRealm: string,
  injection: Awaited<ReturnType<typeof collectUserInjectionData>>
): TaskInfoResponse {
  return {
    task_id: session.id,
    session_id: session.sessionId,
    debug_url: session.debugUrl,
    ws_url: session.wsUrl,
    status: session.status,
    start_url: startUrl,
    current_url: currentUrl,
    auth_realm: authRealm,
    fingerprint_injection: injection.fingerprintInjection,
    passwords: injection.passwords,
    passkeys: injection.passkeys,
    user_settings: injection.userSettings,
    browser_session_metadata: {
      provider: session.sessionId.startsWith('local-') ? 'local' : 'steel',
      steel_profile_id: session.context?.contextId ?? null,
    },
  };
}

async function applyLiveSessionAvailability(
  response: TaskInfoResponse,
  session: NonNullable<Awaited<ReturnType<typeof repo.findSessionByTaskId>>>
) {
  if (session.status !== 'ACTIVE') {
    response.same_session_available = false;
    response.same_session_unavailable_reason = `db_status_${session.status.toLowerCase()}`;
    return response;
  }
  if (session.wsUrl === null || session.wsUrl === undefined || session.wsUrl === '') {
    response.same_session_available = false;
    response.same_session_unavailable_reason = 'missing_ws_url';
    return response;
  }

  let health: Awaited<ReturnType<typeof getSteelSessionHealth>>;
  try {
    health = await getSteelSessionHealth(session.sessionId);
  } catch (error) {
    log.warn('Steel session health check failed', {
      sessionId: session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    response.same_session_available = false;
    response.same_session_unavailable_reason = 'steel_health_check_failed';
    return response;
  }
  response.steel_session_health = health;
  const hasTtl = health.ttlMs === null || health.ttlMs > 0;
  response.same_session_available = isLiveSteelStatus(health.status) && hasTtl;
  if (!response.same_session_available) {
    response.same_session_unavailable_reason =
      health.ttlMs !== null && health.ttlMs <= 0
        ? 'steel_session_expired'
        : `steel_status_${String(health.status ?? 'unknown').toLowerCase()}`;
  }

  return response;
}

export async function getTaskInfo(taskId: string, options: { validateLive?: boolean } = {}) {
  const session = await repo.findSessionByTaskId(taskId);

  if (session === null) {
    return null;
  }

  const currentUrl = session.currentUrl ?? null;
  const startUrl = session.startUrl ?? null;
  const authRealm = canonicalAuthRealm(currentUrl ?? startUrl ?? '');
  const injection = await collectUserInjectionData(session.context?.userId, authRealm, taskId);
  const response = buildTaskInfoResponse(session, currentUrl, startUrl, authRealm, injection);

  return options.validateLive === true ? applyLiveSessionAvailability(response, session) : response;
}
