/**
 * One running batch clock; activity carousel updates never reset its recorded start.
 * With no server start yet (a live thought placeholder carries no timestamp) the clock
 * starts optimistically from the client's first render. When the server start arrives
 * the clock reconciles to the earlier of the two starts, so the shown elapsed only moves
 * forward to the recorded value: it never jumps backwards or resets.
 */
import { useEffect, useState } from 'react';
import { formatWorkDuration } from '../hooks/codeSessionTurns';

/** Below a minute the label shows tenths ("57.7s"); from then on whole seconds ("1m 05s"). */
const TENTHS_UNTIL_MS = 60_000;
const TENTHS_TICK_MS = 100;

/** Delay until the label can next change: the next 100ms step under a minute,
 * the next whole-second boundary after it (no re-render of an unchanged label). */
function nextTickDelay(elapsedMs: number): number {
  if (elapsedMs < TENTHS_UNTIL_MS) return TENTHS_TICK_MS;
  return 1000 - (elapsedMs % 1000);
}

export function useBatchElapsed(startedAt: number | null, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  const validStart = startedAt !== null && Number.isFinite(startedAt) && startedAt > 0;
  // First start seen: the server's when present at mount, else the client's own clock.
  const [firstStart] = useState(() => (validStart ? startedAt : now));
  const start = validStart ? Math.min(firstStart, startedAt) : firstStart;
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      timer = setTimeout(tick, nextTickDelay(Math.max(0, current - start)));
    };
    timer = setTimeout(tick, nextTickDelay(Math.max(0, Date.now() - start)));
    return () => clearTimeout(timer);
  }, [running, start]);
  return formatWorkDuration(Math.max(0, now - start));
}
