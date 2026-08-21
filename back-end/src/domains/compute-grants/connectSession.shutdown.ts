/**
 * Shutdown cleanup for in-flight connect sessions.
 *
 * Separate module so the server can import it without pulling in the browser
 * stack, and so this cannot be quietly dropped from shutdown again -- omitting
 * it stranded 19 live Kernel browsers during development, which exhausted the
 * account's capacity and made every NEW session fail CDP validation.
 */

import { createLogger } from '../../providers/logger';
import { pending } from './connectSession.state';

const log = createLogger('ComputeGrants');

/**
 * Release every in-flight connect browser.
 *
 * Pending sessions live in memory, so a process exit strands whatever is open --
 * and a remote browser bills until released. Restarting the backend during
 * development leaked 19 live Kernel browsers this way, which then exhausted the
 * account's capacity and made every NEW session fail CDP validation. Wired into
 * the server's graceful shutdown.
 */
export async function releaseAllConnectSessions(): Promise<number> {
  const entries = [...pending.values()];
  pending.clear();
  let released = 0;
  await Promise.all(
    entries.map(async (entry) => {
      entry.cdp?.close();
      if (entry.release === null) return;
      try {
        await entry.release();
        released += 1;
      } catch (error) {
        log.warn('connect.shutdown_release_failed', {
          connect_id: entry.connectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );
  if (entries.length > 0) {
    log.info('connect.shutdown_released', { released, total: entries.length });
  }
  return released;
}
