/**
 * Announce a browser task's current provider-session binding to the live view.
 *
 * BrowserSession row (id = task id) --rebind/close committed-->
 *   announceBrowserSessionBinding --read row--> BROWSER_SESSION on agent:<id>
 *
 * Call after the row write commits and before releasing the previous provider
 * session. The payload is read back from the row, so every caller announces
 * exactly what is persisted. `asOf` is taken before that read: a live-view GET
 * that read a newer row afterwards must outrank this announcement. A lost
 * announcement is recovered by the live view's own GET on mount, focus and
 * transcript change, so a failed read is logged and does not fail the swap
 * that triggered it.
 */

import { prisma } from '../database';
import { broadcastBrowserSessionBinding } from '../chat/supabaseBroadcast';
import { createLogger } from '../logger';

const log = createLogger('BrowserSessionBinding');

type BindingWhere = { id: string } | { sessionId: string };

export interface AnnounceBindingDeps {
  now?: () => number;
  findRow?: (where: BindingWhere) => Promise<{
    id: string;
    agentId: string;
    sessionId: string;
    debugUrl: string | null;
    status: string;
  } | null>;
  broadcast?: typeof broadcastBrowserSessionBinding;
}

export async function announceBrowserSessionBinding(
  where: BindingWhere,
  deps: AnnounceBindingDeps = {}
): Promise<void> {
  try {
    const asOf = (deps.now ?? Date.now)();
    const findRow =
      deps.findRow ??
      ((key: BindingWhere) =>
        prisma.browserSession.findUnique({
          where: key,
          select: { id: true, agentId: true, sessionId: true, debugUrl: true, status: true },
        }));
    const row = await findRow(where);
    if (row === null || row.sessionId === null) return;
    await (deps.broadcast ?? broadcastBrowserSessionBinding)(
      row.agentId,
      {
        taskId: row.id,
        sessionId: row.sessionId,
        debugUrl: row.debugUrl,
        status: row.status,
      },
      asOf
    );
  } catch (error) {
    log.warn('Failed to announce browser session binding', {
      ...where,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
