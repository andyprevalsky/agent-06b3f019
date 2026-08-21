/**
 * Connect-session lifecycle: releasing the remote browser and reaping entries.
 *
 * Split out to keep connectSession.ts within its line budget. Operates on the
 * shared `pending` map (imported live), so a success can HOLD its entry -- browser
 * released but record kept -- long enough for the FE to observe `connected`.
 * Deleting it immediately (as the old finish() did) made the poll return
 * `unknown`, which the FE showed as "Sign-in window closed" on a SUCCESSFUL
 * connect.
 */

import { createLogger } from '../../providers/logger';
import { pending, type PendingConnect } from './connectSession';

const log = createLogger('ComputeGrants');

/** Release the remote browser once, and mark WHEN, without deleting the entry. */
export async function releaseBrowser(entry: PendingConnect): Promise<void> {
  entry.finishedAt = Date.now();
  const release = entry.release;
  entry.release = null;
  entry.cdp?.close();
  entry.cdp = null;
  if (release === null) return; // nothing provisioned yet
  await release().catch((err: unknown) => {
    log.error('connect.release_failed', {
      connect_id: entry.connectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function finish(entry: PendingConnect): Promise<void> {
  pending.delete(entry.connectId);
  // Provider-agnostic release. Calling Steel's release on a Kernel session
  // silently leaks a billing browser, which is why the handle carries its own.
  // `release` is null only when the user cancelled before the browser finished
  // provisioning -- there is nothing to release in that window.
  if (entry.release === null) return;
  await entry.release().catch((err: unknown) => {
    log.error('connect.release_failed', {
      connect_id: entry.connectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** How long a succeeded connect is held so the FE can observe `connected`. */
const DONE_HOLD_MS = 90 * 1000;

export async function reapExpiredConnectSessions(now = Date.now()): Promise<number> {
  let reaped = 0;
  for (const entry of [...pending.values()]) {
    if (entry.finishedAt === undefined && now > entry.deadline) {
      await finish(entry); // past deadline, never finished -> release + delete
      reaped += 1;
    } else if (entry.finishedAt !== undefined && now - entry.finishedAt > DONE_HOLD_MS) {
      pending.delete(entry.connectId); // held-for-FE grace elapsed -> delete
      reaped += 1;
    }
  }
  if (reaped > 0) log.info('connect.reaped', { count: reaped });
  return reaped;
}
