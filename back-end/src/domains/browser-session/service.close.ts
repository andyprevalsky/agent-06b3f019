/**
 * Close/pause a browser session. The provider close first merges the task's
 * forked sites into Root (plan row A6) and returns that receipt; a retried
 * close returns the recorded outcome without writing again.
 */
import { closeSession } from '../../providers/browser';
import { createLogger } from '../../providers/logger';

const log = createLogger('BrowserSession');

/* c8 ignore start -- the provider close requires a Steel/Kernel session */
export async function closeBrowserSession(
  sessionId: string,
  pause: boolean,
  currentUrl?: string,
  signedInSites?: string[]
) {
  log.info(`${pause ? 'Pausing' : 'Closing'} browser session`, {
    sessionId,
    currentUrl: currentUrl !== undefined && currentUrl !== '' ? currentUrl : 'NULL/EMPTY',
  });

  const { worldState } = await closeSession(sessionId, pause, currentUrl, { signedInSites });

  return {
    status: pause ? ('PAUSED' as const) : ('CLOSED' as const),
    world_state: worldState,
  };
}
/* c8 ignore stop */
