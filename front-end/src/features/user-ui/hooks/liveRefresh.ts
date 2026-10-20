/**
 * Live refresh of the active user UI (no page reload).
 *
 *   open agent: new message / status change ─┐   (existing agent:<id> channel,
 *   sub-agent tree state change ──────────────┤    existing bus:<root> channel)
 *   `user_ui.published` event (future) ───────┼─► refreshActiveUserUi()
 *   direct refreshActiveUserUi() call ────────┘          │
 *                                                        ▼
 *     every mounted UserUiProvider (Rose Desktop only) → coalescer:
 *       first request opens a 750ms window; requests inside it are dropped;
 *       at the window's end ONE GET /api/user-ui/active (never two in flight;
 *       a request during the flight queues one more window); unmount cancels.
 *
 * The coalescer is per provider (one per tab), so per realtime event the cost
 * is O(1): one Set walk and at most one timer check.
 */

import { USER_UI_REFRESH_WINDOW_MS } from '../config';
import { USER_UI_PUBLISHED_EVENT, type UserUiPublishedEvent } from '../types';

/** One mounted provider's refresh entry point. */
export interface UserUiRefresher {
  /** Request a coalesced refetch of GET /api/user-ui/active. */
  request: () => void;
  /** versionId currently applied by that provider (null = stock UI). */
  currentVersionId: () => string | null;
}

const refreshers = new Set<UserUiRefresher>();

export function registerUserUiRefresher(refresher: UserUiRefresher): () => void {
  refreshers.add(refresher);
  return () => {
    refreshers.delete(refresher);
  };
}

/** Refetch the active user UI in every mounted provider (no-op when none). */
export function refreshActiveUserUi(): void {
  refreshers.forEach((refresher) => refresher.request());
}

/**
 * Entry point for the backend `user_ui.published` realtime event. A publish of
 * the version already on screen is a no-op; anything else refreshes.
 */
export function handleUserUiPublishedEvent(event: UserUiPublishedEvent): void {
  if (event.type !== USER_UI_PUBLISHED_EVENT) return;
  refreshers.forEach((refresher) => {
    if (refresher.currentVersionId() !== event.versionId) refresher.request();
  });
}

export interface RefreshCoalescer {
  request: () => void;
  dispose: () => void;
}

/**
 * At most one `run()` per window and never two concurrently. Requests during a
 * window are absorbed; a request during an in-flight run schedules exactly one
 * more window after it settles. dispose() cancels the pending window.
 */
export function createRefreshCoalescer(
  run: () => Promise<void>,
  windowMs: number = USER_UI_REFRESH_WINDOW_MS,
): RefreshCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let queued = false;
  let disposed = false;

  const fire = () => {
    timer = null;
    if (disposed) return;
    inFlight = true;
    void run().finally(() => {
      inFlight = false;
      if (queued && !disposed) {
        queued = false;
        request();
      }
    });
  };

  function request() {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(fire, windowMs);
  }

  return {
    request,
    dispose: () => {
      disposed = true;
      queued = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
