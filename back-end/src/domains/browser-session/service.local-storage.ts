import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import { injectLocalStorageViaCdp } from './service.cdp';
import { SessionNoWsUrlError } from './types';
import { WORKER_APPLY_REASON } from './service.worker-apply';

const log = createLogger('BrowserSession');

export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'SessionNotFoundError';
  }
}

export class SessionNoUserError extends Error {
  constructor() {
    super('Session has no associated user');
    this.name = 'SessionNoUserError';
  }
}

/* c8 ignore start -- injectLocalStorage requires Steel session + CDP connection */
export async function injectLocalStorage(sessionId: string, origin: string) {
  log.info('Inject localStorage request', { sessionId, origin });

  const session = await repo.findSessionBySessionId(sessionId);

  if (session === null) {
    throw new SessionNotFoundError();
  }

  if (session.context?.userId === null || session.context?.userId === undefined) {
    throw new SessionNoUserError();
  }

  const originData = await repo.findLocalStorageOrigin(session.context.userId, origin);

  if (originData === null) {
    log.info('No localStorage data for origin', { origin });
    return { injected: false, reason: 'no_data_for_origin' as const, count: 0 };
  }

  const entries = originData.entries as { key: string; value: string }[];
  const currentHash = originData.hash;

  if (entries.length === 0) {
    log.info('No localStorage entries for origin', { origin });
    return { injected: false, reason: 'no_data_for_origin' as const, count: 0 };
  }

  const injectedOrigins = (session.injectedOrigins as Record<string, string> | null) ?? {};
  const injectedHash: string | undefined = injectedOrigins[origin];

  if (injectedHash !== undefined && injectedHash === currentHash) {
    log.info('Origin already injected with same hash, skipping', { origin });
    return { injected: false, reason: 'already_injected' as const, count: entries.length };
  }

  if (session.provider === 'tilion') {
    // The worker holds Tilion's only CDP socket and applies these entries itself.
    // injectedOrigins is not updated: the backend did not inject anything.
    return {
      injected: false,
      reason: WORKER_APPLY_REASON,
      count: entries.length,
      worker_apply: {
        provider: 'tilion' as const,
        reason: WORKER_APPLY_REASON,
        cookies: [],
        local_storage: [{ origin, entries }],
      },
    };
  }

  if (session.wsUrl === null || session.wsUrl === undefined || session.wsUrl === '') {
    throw new SessionNoWsUrlError();
  }

  await injectLocalStorageViaCdp(session.wsUrl, entries, origin);

  const updatedInjectedOrigins = {
    ...injectedOrigins,
    [origin]:
      currentHash !== null && currentHash !== undefined && currentHash !== ''
        ? currentHash
        : 'unknown',
  };

  await repo.updateInjectedOrigins(sessionId, updatedInjectedOrigins);

  log.info('Updated session injectedOrigins', { origin });

  return {
    injected: true,
    reason: injectedHash !== undefined ? ('data_changed' as const) : ('first_injection' as const),
    count: entries.length,
  };
}
/* c8 ignore stop */
