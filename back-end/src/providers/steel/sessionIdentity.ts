/**
 * Ownership of Steel sessions.
 *
 * Every Rose environment (production, each local workspace, each isolated
 * benchmark stack) shares one Steel account, and Steel keeps no record of who
 * created a session. So we choose the session id ourselves: the first eight hex
 * characters are a marker derived from this environment's identity, the rest is
 * random. The reaper (sessionReaper.ts) then releases only sessions this
 * environment created and no longer holds, and never touches a neighbour's.
 *
 *   marker = sha256(RENDER_SERVICE_ID | BENCHMARK_RUN_ID | CONDUCTOR_WORKSPACE_NAME | "local")[0:8]
 *   id     = marker-xxxx-4xxx-yxxx-xxxxxxxxxxxx   (a valid v4 UUID)
 *
 * Sessions still being set up (a recovery lane candidate, a token-minting
 * browser, a replacement that is not yet committed) have no BrowserSession row
 * yet, so they register here while this process holds them.
 */

import { createHash, randomUUID } from 'node:crypto';

const MARKER_LENGTH = 8;

/** The fallback when nothing identifies this stack; it is shared, so it must never reap. */
export const SHARED_STEEL_IDENTITY = 'local';

export function steelEnvironmentIdentity(env: NodeJS.ProcessEnv = process.env): string {
  // Most specific first. Local back-end/.env files carry RENDER_SERVICE_ID for the
  // Render API scripts, so that id only identifies production when Render itself
  // set RENDER=true; otherwise a developer stack would share production's marker.
  const candidates = [
    ['benchmark', env.BENCHMARK_ISOLATED_RUN === 'true' ? env.BENCHMARK_RUN_ID : undefined],
    ['workspace', env.CONDUCTOR_WORKSPACE_NAME],
    ['render', env.RENDER === 'true' ? env.RENDER_SERVICE_ID : undefined],
  ] as const;
  for (const [kind, value] of candidates) {
    const trimmed = (value ?? '').trim();
    if (trimmed !== '') return `${kind}:${trimmed}`;
  }
  return SHARED_STEEL_IDENTITY;
}

export function steelOwnershipMarker(identity: string = steelEnvironmentIdentity()): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, MARKER_LENGTH);
}

/** A fresh v4 UUID whose first segment is this environment's ownership marker. */
export function newOwnedSteelSessionId(marker: string = steelOwnershipMarker()): string {
  return `${marker}${randomUUID().slice(MARKER_LENGTH)}`;
}

export function isOwnedSteelSessionId(
  sessionId: string,
  marker: string = steelOwnershipMarker()
): boolean {
  return sessionId.toLowerCase().startsWith(marker);
}

// Sessions this process is still setting up or using without a BrowserSession row.
// Once the row commits it holds the session, so an entry only has to outlive
// setup; entries older than this are dropped so the map cannot grow with every
// committed session and the reaper never skips a session on a stale entry.
const IN_FLIGHT_TTL_MS = 20 * 60 * 1000;
const inFlight = new Map<string, number>();

export function registerInFlightSteelSession(sessionId: string): void {
  inFlight.set(sessionId, Date.now());
}

export function unregisterInFlightSteelSession(sessionId: string): void {
  inFlight.delete(sessionId);
}

export function inFlightSteelSessionIds(now: number = Date.now()): ReadonlySet<string> {
  for (const [sessionId, registeredAt] of inFlight) {
    if (now - registeredAt > IN_FLIGHT_TTL_MS) inFlight.delete(sessionId);
  }
  return new Set(inFlight.keys());
}
