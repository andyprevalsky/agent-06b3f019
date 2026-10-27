/** Browser-state carry for a rotation that switches a run OFF Tilion (to Kernel/Steel). */
import { prisma } from './database';
import {
  getTilionSessionHealth,
  isTilionSessionEndedError,
  TilionUncarriedStateError,
  type TilionCarriedState,
} from './browser/tilion';
import { loadPausedState } from './browser/tilionState';

export async function tilionSessionLive(sessionId: string): Promise<boolean> {
  try {
    const health = await getTilionSessionHealth(sessionId);
    return health.status === 'ready' || health.status === 'remote';
  } catch (error) {
    // Unknown liveness is treated as live: never swap a browser whose state may be lost.
    return !isTilionSessionEndedError(error);
  }
}

/**
 * State for a switch OFF Tilion (to Kernel/Steel). The backend cannot read a
 * live Tilion session (one CDP client, held by the worker), and only
 * /recover-challenge carries the worker's capture. So: a paused row's durable
 * snapshot (pausedBrowserState) is carried; a still-live session without it
 * fails closed with TilionUncarriedStateError (HTTP 409 carried_state_required)
 * instead of silently landing on a blank browser.
 */
export async function carryForTilionSwitch(
  taskId: string,
  carry: { carriedState?: TilionCarriedState },
  isLive: (sessionId: string) => Promise<boolean> = tilionSessionLive
): Promise<{ carry: { carriedState?: TilionCarriedState }; fromPausedState: boolean }> {
  if (carry.carriedState !== undefined) return { carry, fromPausedState: false };
  const row = await prisma.browserSession.findUniqueOrThrow({
    where: { id: taskId },
    select: { sessionId: true },
  });
  // An unmaterialized logical browser has no provider session and no snapshot.
  if (row.sessionId === null) return { carry, fromPausedState: false };
  const paused = await loadPausedState(taskId, row.sessionId);
  if (paused !== null) return { carry: { carriedState: paused }, fromPausedState: true };
  if (await isLive(row.sessionId)) {
    throw new TilionUncarriedStateError(taskId, row.sessionId);
  }
  return { carry, fromPausedState: false };
}
