/**
 * In-place Tilion exit rotation (`POST rotate-ip`) for the residential step.
 * Works while the worker holds CDP (~80 ms live; CDP and storage kept). The
 * proof of exit movement is `rotated: true` for this session. The explicit
 * `fresh_allocation` boolean distinguishes a brand-new allocation from another
 * pooled address (API reference §8); both preserve the browser and its state.
 * A malformed/unacknowledged response or refusal
 * (409 ip_rotation_unavailable / residential_rotation_unavailable /
 * exit_ladder_exhausted, 503) returns null and the
 * caller replaces the session with the worker's carriedState.
 */
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import type { TilionReplacementSession } from './tilion';
import { storedTilionProxyType } from './tilionConfig';
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

interface RotateIpResponse {
  session_id?: string;
  rotated?: boolean;
  fresh_allocation?: boolean;
  region?: string | null;
}

export async function rotateInPlace(taskId: string): Promise<TilionReplacementSession | null> {
  const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  if (
    row.provider !== 'tilion' ||
    row.status !== 'ACTIVE' ||
    row.sessionId === null ||
    !row.wsUrl ||
    !row.debugUrl
  ) {
    return null;
  }
  // rotate-ip keeps the exit class; a datacenter session reaches residential by replacement.
  if (storedTilionProxyType(row.proxyTier) === 'direct') return null;
  let response: RotateIpResponse | null;
  try {
    // Not retried: a lost reply may already have moved the exit.
    response = await tilionRequest<RotateIpResponse>(
      tilionSessionPath(row.sessionId, '/rotate-ip'),
      { method: 'POST', timeoutMs: 30_000, maxAttempts: 1 }
    );
  } catch (error) {
    log.warn('Tilion rotate-ip refused; using a replacement session', {
      taskId,
      sessionId: row.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const ipRotation = {
    rotated: response?.rotated === true,
    freshAllocation: response?.fresh_allocation === true,
    region: typeof response?.region === 'string' ? response.region : null,
  };
  if (
    !ipRotation.rotated ||
    typeof response?.fresh_allocation !== 'boolean' ||
    response.session_id !== row.sessionId
  ) {
    log.warn(
      'Tilion rotate-ip did not acknowledge this session rotation; using a replacement session',
      {
        taskId,
        sessionId: row.sessionId,
        ...ipRotation,
      }
    );
    return null;
  }
  const source = `tilion_residential_rotated_${ipRotation.region ?? 'unknown'}`;
  const updated = await prisma.browserSession.updateMany({
    where: { id: taskId, sessionId: row.sessionId },
    data: { proxyTier: 'residential', kernelProxySource: source },
  });
  if (updated.count !== 1) {
    throw new Error(`Browser task ${taskId} changed during in-place rotation`);
  }
  log.info('Tilion rotate-ip moved the residential exit in place', {
    taskId,
    sessionId: row.sessionId,
    ...ipRotation,
  });
  // The worker keeps this session's only CDP socket: no validation client.
  return {
    provider: 'tilion',
    sessionId: row.sessionId,
    debugUrl: row.debugUrl,
    wsUrl: row.wsUrl,
    savedUrl: row.currentUrl || row.startUrl || undefined,
    proxySource: source,
    proxyLocation: await agentLocation(row.agentId),
    profileId: null,
    profileSource: 'tilion_rotated_in_place',
    previousSessionId: row.sessionId,
    previousProvider: 'tilion',
    ipRotation,
  };
}
