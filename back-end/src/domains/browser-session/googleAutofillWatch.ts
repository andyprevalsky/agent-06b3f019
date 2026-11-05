/**
 * Google saved-password autofill while the USER drives a live browser.
 *
 * Starts the moment a human takes control of a session (POST /control
 * {mode:user}, or the internal acknowledge of the legacy handshake) -- the same
 * trigger whether they are connecting an account or answering an agent's auth
 * assistance, since both hand off the one live session. While the user holds
 * control we watch the browser: once Google shows a password challenge for an
 * account the user has saved passwords for, we submit them newest-used first,
 * one per tick, until Google accepts one or the list is exhausted (see
 * connectSession.googlePassword).
 *
 * BOUNDED per session: one watcher, one CDP socket, keyed by taskId. It stops
 * when the user hands control back, the session ends, the 15-minute cap passes,
 * or the browser becomes unreachable -- so cost scales with sessions a human is
 * actively driving, never with agent count.
 */

import { createLogger } from '../../providers/logger';
import { attachCdp, type CdpClient } from '../compute-grants/cdp';
import {
  autofillGooglePassword,
  type GoogleAutofillTarget,
  type GooglePasswordLookup,
} from '../compute-grants/connectSession.googlePassword';
import * as repo from './repo';

const log = createLogger('BrowserControl');

const POLL_MS = 2_000;
const MAX_WATCH_MS = 15 * 60 * 1000;
const MAX_ATTACH_FAILURES = 5;

const watching = new Set<string>();

export interface GoogleAutofillWatchDeps {
  /** True while the human still holds the live session (USER + ACTIVE). */
  isUserControlling: (taskId: string) => Promise<boolean>;
  attach: (wsUrl: string) => Promise<CdpClient>;
  lookup?: GooglePasswordLookup;
  pollMs?: number;
}

const defaultDeps: GoogleAutofillWatchDeps = {
  isUserControlling: async (taskId) => {
    const session = await repo.findBrowserControlRecord(taskId);
    return session !== null && session.status === 'ACTIVE' && session.controlState === 'USER';
  },
  attach: attachCdp,
};

/**
 * Begin autofilling on the session the user just took control of.
 *
 * `wsUrl` is null for a provider with no CDP endpoint (nothing to drive); the
 * watch is a no-op then, and a second start for the same task is ignored.
 */
export function startTakeControlAutofill(
  taskId: string,
  userId: string,
  wsUrl: string | null | undefined,
  deps: GoogleAutofillWatchDeps = defaultDeps
): void {
  if (wsUrl === null || wsUrl === undefined || wsUrl === '' || watching.has(taskId)) return;
  watching.add(taskId);

  const target: GoogleAutofillTarget = {
    cdp: null,
    userId,
    connectId: taskId,
    provider: 'take-control',
  };
  const deadline = Date.now() + MAX_WATCH_MS;
  let attachFailures = 0;
  let inFlight = false;

  const stop = (timer: NodeJS.Timeout) => {
    clearInterval(timer);
    watching.delete(taskId);
    target.cdp?.close();
    target.cdp = null;
  };

  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        if (Date.now() > deadline || !(await deps.isUserControlling(taskId))) {
          stop(timer);
          return;
        }
        target.cdp ??= await deps.attach(wsUrl);
        await autofillGooglePassword(target, deps.lookup);
      } catch (error) {
        // A dead socket is dropped so the next tick re-attaches; give up after a
        // few failures, when the browser is simply gone.
        target.cdp?.close();
        target.cdp = null;
        attachFailures += 1;
        if (attachFailures >= MAX_ATTACH_FAILURES) {
          log.warn('Google autofill watcher gave up', {
            task_id: taskId,
            error: error instanceof Error ? error.message : String(error),
          });
          stop(timer);
        }
      } finally {
        inFlight = false;
      }
    })();
  }, deps.pollMs ?? POLL_MS);
}
