/**
 * Read-only Steel session health / cookie / cleanup helpers.
 * Split from session.ts for max-lines.
 */

import { prisma } from '../database';
import {
  summarizeSteelCaptchaStatus,
  type BrowserCaptchaTelemetry,
} from '../browser/captchaTelemetry';
import { closeSession, steel } from './session';
import { log } from './types';

export interface SteelSessionHealth {
  sessionId: string;
  status: string | null;
  createdAt: string | null;
  timeoutMs: number | null;
  expiresAt: string | null;
  ttlMs: number | null;
  profileId: string | null;
}

export interface SteelSessionCookieSummary {
  sessionId: string;
  authRealm: string;
  cookieCount: number;
  checkedAt: string;
}

/** Get session info from database. */
export async function getSession(sessionId: string) {
  return await prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: true },
  });
}

export async function getSteelSessionHealth(sessionId: string): Promise<SteelSessionHealth> {
  const remote = (await steel.sessions.retrieve(sessionId)) as {
    id?: string;
    status?: string;
    createdAt?: string;
    timeout?: number;
    profileId?: string | null;
  };
  const createdAtMs =
    remote.createdAt !== undefined ? new Date(remote.createdAt).getTime() : Number.NaN;
  const timeoutMs = typeof remote.timeout === 'number' ? remote.timeout : null;
  const expiresAtMs =
    Number.isFinite(createdAtMs) && timeoutMs !== null ? createdAtMs + timeoutMs : Number.NaN;
  return {
    sessionId: remote.id ?? sessionId,
    status: remote.status ?? null,
    createdAt: remote.createdAt ?? null,
    timeoutMs,
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    ttlMs: Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : null,
    profileId: remote.profileId ?? null,
  };
}

export async function getSteelCaptchaTelemetry(
  sessionId: string
): Promise<BrowserCaptchaTelemetry> {
  const statuses = await steel.sessions.captchas.status(sessionId);
  return summarizeSteelCaptchaStatus(statuses);
}

export async function getSteelSessionCookieSummary(
  sessionId: string,
  authRealm: string
): Promise<SteelSessionCookieSummary> {
  const context = (await steel.sessions.context(sessionId)) as {
    cookies?: Array<{ domain?: string; expires?: number }>;
  };
  const normalizedRealm = authRealm.toLowerCase().replace(/^\./, '');
  const nowSeconds = Date.now() / 1000;
  const cookieCount = (context.cookies ?? []).filter((cookie) => {
    const domain = (cookie.domain ?? '').toLowerCase().replace(/^\./, '');
    const domainMatches = domain === normalizedRealm || domain.endsWith(`.${normalizedRealm}`);
    const expires = cookie.expires;
    const live = expires === undefined || expires <= 0 || expires > nowSeconds;
    return domainMatches && live;
  }).length;
  return {
    sessionId,
    authRealm: normalizedRealm,
    cookieCount,
    checkedAt: new Date().toISOString(),
  };
}

/** Close all active browser sessions (for cleanup). */
export async function closeAllActiveSessions(): Promise<number> {
  log.info('🌐 Finding all active browser sessions...');

  // Steel-only closeSession: Kernel ACTIVE rows must not be selected or they
  // get marked CLOSED while the Kernel remote browser stays alive.
  const activeSessions = await prisma.browserSession.findMany({
    where: { status: 'ACTIVE', provider: 'steel' },
    select: { sessionId: true, agentId: true },
  });

  log.info(`   Found ${activeSessions.length} active session(s)`);

  if (activeSessions.length === 0) {
    return 0;
  }

  let closedCount = 0;

  for (const session of activeSessions) {
    if (session.sessionId === null) continue;
    try {
      log.info(`   Closing session ${session.sessionId} (agent: ${session.agentId})...`);
      await closeSession(session.sessionId);
      closedCount++;
    } catch (error) {
      log.error(`Failed to close session ${session.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info(`✅ Closed ${closedCount}/${activeSessions.length} session(s)`);

  return closedCount;
}
