import { getFingerprintInjectionData, getSteelSessionHealth } from '../../providers/steel';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import { serializePasswords } from './service.serializers';

const log = createLogger('BrowserSession');

function isLiveSteelStatus(status: string | null): boolean {
  if (status === null) return false;
  return ['live', 'active', 'running'].includes(status.toLowerCase());
}

export async function getTaskOwnerUserId(taskId: string): Promise<string | undefined> {
  const session = await repo.findSessionByTaskId(taskId);
  return session?.context?.userId ?? undefined;
}

export async function getTaskInfo(taskId: string, options: { validateLive?: boolean } = {}) {
  const session = await repo.findSessionByTaskId(taskId);

  if (session === null) {
    return null;
  }

  let fingerprintInjection = null;
  let serializedPasswords: ReturnType<typeof serializePasswords> = [];

  if (session.context?.userId !== null && session.context?.userId !== undefined) {
    fingerprintInjection = await getFingerprintInjectionData(session.context.userId);

    const passwords = await repo.findPasswords(session.context.userId);
    serializedPasswords = serializePasswords(passwords);
  }

  const response: {
    task_id: string;
    session_id: string;
    debug_url: string | null;
    ws_url: string | null;
    status: string;
    fingerprint_injection: unknown;
    passwords: ReturnType<typeof serializePasswords>;
    same_session_available?: boolean;
    same_session_unavailable_reason?: string;
    steel_session_health?: Awaited<ReturnType<typeof getSteelSessionHealth>>;
  } = {
    task_id: session.id,
    session_id: session.sessionId,
    debug_url: session.debugUrl,
    ws_url: session.wsUrl,
    status: session.status,
    fingerprint_injection: fingerprintInjection,
    passwords: serializedPasswords,
  };

  if (options.validateLive !== true) return response;

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
