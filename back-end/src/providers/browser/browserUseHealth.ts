import type * as resumeRecovery from './resumeRecovery';
import type { BrowserSessionHealth } from './types';
import { request } from './browserUseClient';

export async function getBrowserUseSessionHealth(sessionId: string): Promise<BrowserSessionHealth> {
  let session: resumeRecovery.BrowserUseSession;
  try {
    session = await request<resumeRecovery.BrowserUseSession>(
      `/browsers/${encodeURIComponent(sessionId)}`
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
      return {
        provider: 'browser-use',
        sessionId,
        status: 'deleted',
        createdAt: null,
        timeoutMs: null,
        expiresAt: null,
        ttlMs: null,
        profileId: null,
      };
    }
    throw error;
  }
  const expiresAt = new Date(session.timeoutAt).getTime();
  const createdAt = new Date(session.startedAt).getTime();
  return {
    provider: 'browser-use',
    sessionId,
    status: session.status,
    createdAt: session.startedAt,
    expiresAt: session.timeoutAt,
    timeoutMs: expiresAt - createdAt,
    ttlMs: Math.max(0, expiresAt - Date.now()),
    profileId: null,
  };
}
