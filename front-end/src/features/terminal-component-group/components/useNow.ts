/**
 * One ticking clock for the whole agent list.
 *
 * The sidebar shows a live elapsed label on every active row. A timer per row
 * would mean one interval per agent — at a few hundred agents that is hundreds
 * of intervals waking the main thread on their own schedules, and it scales with
 * agent count rather than with what is on screen. Instead the list holds a
 * single interval and passes `now` down; rows stay pure.
 *
 * The interval is also gated on there being at least one active row, so an
 * all-finished sidebar runs no timer at all.
 *
 * [enabled=false] --no timer--> now frozen at mount
 * [enabled=true]  --setInterval(periodMs)--> now advances
 */

import { useEffect, useState } from 'react';

export function useNow(periodMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    // Re-sync immediately so a row that just became active is not showing a
    // timestamp captured before it started.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs, enabled]);

  return now;
}
