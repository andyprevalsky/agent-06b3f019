/**
 * In-place Tilion exit rotation (`POST rotate-ip`), accepted only with proof:
 * the exit IP read through the session's own browser must differ before and
 * after. Without proof the caller falls back to a replacement session.
 */
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { connectValidatedBrowser } from '../steel/sessionConnection';
import type { TilionReplacementSession } from './tilion';
import { tilionRequest, tilionSessionPath } from './tilionClient';

const log = createLogger('Tilion');

export async function agentLocation(agentId: string): Promise<ProxyGeoLocation> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  return agent?.proxyCountry
    ? {
        country: agent.proxyCountry,
        ...(agent.proxyState ? { state: agent.proxyState } : {}),
        ...(agent.proxyCity ? { city: agent.proxyCity } : {}),
      }
    : DEFAULT_GEOLOCATION;
}

const EXIT_IP_ECHO_URL = 'https://api.ipify.org?format=json';

/** The session's exit IP, read through its own browser; null when it cannot be read now. */
async function sessionExitIp(sessionId: string): Promise<string | null> {
  try {
    const result = await tilionRequest<{ content_base64?: string }>(
      tilionSessionPath(sessionId, '/files/fetch'),
      { method: 'POST', body: { url: EXIT_IP_ECHO_URL, max_bytes: 1024 }, timeoutMs: 30_000 }
    );
    const parsed = JSON.parse(Buffer.from(result?.content_base64 ?? '', 'base64').toString('utf8'));
    return typeof parsed?.ip === 'string' ? parsed.ip : null;
  } catch (error) {
    // While the worker holds CDP, files/fetch answers 502 ExternalControlBusy.
    log.info('Tilion exit IP unreadable; in-place rotation not provable', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * `POST rotate-ip` keeps CDP, cookies and tabs, but counts only when the exit
 * IP is proven to change. Any missing proof returns null so the caller uses a
 * replacement session instead. Success returns `previousSessionId === sessionId`.
 */
export async function rotateInPlace(
  taskId: string,
  options: { keepValidationConnection?: boolean }
): Promise<TilionReplacementSession | null> {
  const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  if (row.provider !== 'tilion' || row.status !== 'ACTIVE' || !row.wsUrl || !row.debugUrl) {
    return null;
  }
  const before = await sessionExitIp(row.sessionId);
  if (before === null) return null;
  try {
    await tilionRequest(tilionSessionPath(row.sessionId, '/rotate-ip'), {
      method: 'POST',
      timeoutMs: 30_000,
    });
  } catch (error) {
    log.warn('Tilion rotate-ip refused; using a replacement session', {
      sessionId: row.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const after = await sessionExitIp(row.sessionId);
  if (after === null || after === before) {
    log.warn('Tilion rotate-ip did not prove a new exit IP; using a replacement session', {
      sessionId: row.sessionId,
      changed: after === null ? 'unknown' : false,
    });
    return null;
  }
  const updated = await prisma.browserSession.updateMany({
    where: { id: taskId, sessionId: row.sessionId },
    data: { proxyTier: 'residential' },
  });
  if (updated.count !== 1) return null;
  log.info('Tilion rotate-ip changed the exit IP in place', { taskId, sessionId: row.sessionId });
  const validationBrowser = options.keepValidationConnection
    ? await connectValidatedBrowser(row.wsUrl)
    : null;
  return {
    ...(validationBrowser ? { validationBrowser } : {}),
    provider: 'tilion',
    sessionId: row.sessionId,
    debugUrl: row.debugUrl,
    wsUrl: row.wsUrl,
    savedUrl: row.currentUrl || row.startUrl || undefined,
    proxySource: row.kernelProxySource ?? 'tilion_residential_country',
    proxyLocation: await agentLocation(row.agentId),
    profileId: null,
    profileSource: 'tilion_rotated_in_place',
    previousSessionId: row.sessionId,
    previousProvider: 'tilion',
  };
}
