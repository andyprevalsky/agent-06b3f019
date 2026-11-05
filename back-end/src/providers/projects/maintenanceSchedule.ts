/**
 * Template sync schedule: ONE nightly slot per UTC day for every project that
 * turned the schedule on, plus the deterministic slot keys that make duplicate
 * triggers (several backend replicas, a retried tick) a no-op through
 * ProjectMaintenanceRun's unique (projectId, slotKey).
 *
 *   cron tick ─► nightly: slot "nightly:2026-10-28" once the day's boundary passed
 *             └─► github : slot "github:<head sha>"   (one run per observed head)
 *
 * 10k-agent behaviour: pure functions of the clock; no state.
 */

/** 10:00 UTC = 03:00 Pacific (PDT): after the US working day, before the next. */
export const NIGHTLY_HOUR_UTC = 10;

export function nightlyBoundary(now: Date): Date {
  const boundary = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_HOUR_UTC)
  );
  if (boundary.getTime() > now.getTime()) boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary;
}

/** The slot key of the most recent boundary that has passed. */
export function nightlySlotKey(now: Date): string {
  return `nightly:${nightlyBoundary(now).toISOString().slice(0, 10)}`;
}

export function nextNightlyRun(now: Date): Date {
  const next = new Date(nightlyBoundary(now));
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function githubSlotKey(headSha: string): string {
  return `github:${headSha}`;
}

/** A GitHub head poll is due when the project was never checked or the interval passed. */
export const GITHUB_POLL_INTERVAL_MS = 5 * 60_000;
