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

export function steelEnvironmentIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    ['render', env.RENDER_SERVICE_ID],
    ['benchmark', env.BENCHMARK_ISOLATED_RUN === 'true' ? env.BENCHMARK_RUN_ID : undefined],
    ['workspace', env.CONDUCTOR_WORKSPACE_NAME],
  ] as const;
  for (const [kind, value] of candidates) {
    const trimmed = (value ?? '').trim();
    if (trimmed !== '') return `${kind}:${trimmed}`;
  }
  return 'local';
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
const inFlight = new Map<string, number>();

export function registerInFlightSteelSession(sessionId: string): void {
  inFlight.set(sessionId, Date.now());
}

export function unregisterInFlightSteelSession(sessionId: string): void {
  inFlight.delete(sessionId);
}

export function inFlightSteelSessionIds(): ReadonlySet<string> {
  return new Set(inFlight.keys());
}
