/**
 * Compact elapsed-time formatting for the sidebar's active rows.
 *
 * The sidebar is narrow and the label sits to the right of the title, so the
 * format trades precision for width as the run gets longer — the difference
 * between 3h 20m and 3h 21m does not change what you do, but a label that grows
 * past ~6 characters starts eating the title.
 *
 *   < 1m    "45s"
 *   < 1h    "4m"
 *   < 24h   "3h"                 (minutes are too wide/noisy beside a title)
 *   < 7d    "2d" / "2d 4h"       (multi-day runs are the reason this exists)
 *   >= 7d   "12d"                (hours are noise at this scale)
 *
 * Clamps negatives to 0: clock skew between the server's created_at and the
 * browser can otherwise render "-3s" for a run that just started.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatElapsed(elapsedMs: number): string {
  const ms = Math.max(0, elapsedMs);

  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;

  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    return `${hours}h`;
  }

  const days = Math.floor(ms / DAY);
  if (ms >= WEEK) return `${days}d`;

  const hours = Math.floor((ms % DAY) / HOUR);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * How often a label of this age visibly changes — used to pick a tick interval
 * so a week-old run is not re-rendering every 30 seconds.
 */
export function elapsedTickIntervalMs(elapsedMs: number): number {
  const ms = Math.max(0, elapsedMs);
  if (ms < MINUTE) return SECOND;
  if (ms < DAY) return 30 * SECOND;
  return 5 * MINUTE;
}

/** Milliseconds a run has been going, from an ISO timestamp. */
export function elapsedSince(isoTimestamp: string, now: number): number {
  const started = new Date(isoTimestamp).getTime();
  return Number.isNaN(started) ? 0 : now - started;
}
