/** Provider-confirmed loss of a paused logical browser source. */
import { isConfirmedBrowserEnd } from './sessionPersist';
import type { BrowserSessionHealth } from './types';

/**
 * A pause always publishes a checkpoint, so a PAUSED logical source without one
 * was paused because its provider ended it. Re-confirm that end before a resume
 * accepts the state loss; a live or unknown source still needs its checkpoint.
 */
export async function pausedSourceEnded(
  row: {
    logicalOwnerKey: string | null;
    sessionId: string | null;
    status: string;
    checkpointRef: string | null;
  },
  getHealth: (sessionId: string) => Promise<Pick<BrowserSessionHealth, 'sessionId' | 'status'>>
): Promise<boolean> {
  if (!row.logicalOwnerKey || !row.sessionId || row.status !== 'PAUSED' || row.checkpointRef)
    return false;
  const health = await getHealth(row.sessionId);
  if (health.sessionId !== row.sessionId) throw new Error('Browser resume health binding changed');
  return isConfirmedBrowserEnd(health.status);
}
