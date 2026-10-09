/**
 * Announce a browser task's current provider-session binding to the live view.
 *
 * BrowserSession row (id = task id) --rebind/close committed-->
 *   announceBrowserSessionBinding --read row--> BROWSER_SESSION on agent:<id>
 *
 * Call after the row write commits and before releasing the previous provider
 * session. The payload is read back from the row, so every caller announces
 * exactly what is persisted. A lost announcement is recovered by the live
 * view's own GET on mount, focus and transcript change, so a failed read is
 * logged and does not fail the swap that triggered it.
 */

import { prisma } from '../database';
import { broadcastBrowserSessionBinding } from '../chat/supabaseBroadcast';
import { createLogger } from '../logger';

const log = createLogger('BrowserSessionBinding');

export async function announceBrowserSessionBinding(
  where: { id: string } | { sessionId: string }
): Promise<void> {
  try {
    const row = await prisma.browserSession.findUnique({
      where,
      select: { id: true, agentId: true, sessionId: true, debugUrl: true, status: true },
    });
    if (row === null) return;
    await broadcastBrowserSessionBinding(row.agentId, {
      taskId: row.id,
      sessionId: row.sessionId,
      debugUrl: row.debugUrl,
      status: row.status,
    });
  } catch (error) {
    log.warn('Failed to announce browser session binding', {
      ...where,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
