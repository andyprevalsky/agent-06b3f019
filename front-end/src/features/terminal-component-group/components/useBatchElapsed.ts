/** One running batch clock; activity carousel updates never reset its recorded start. */
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
  useEffect(() => {
    if (!running || !validStart) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      timer = setTimeout(tick, nextTickDelay(Math.max(0, current - startedAt)));
    };
    timer = setTimeout(tick, nextTickDelay(Math.max(0, Date.now() - startedAt)));
    return () => clearTimeout(timer);
  }, [running, validStart, startedAt]);
  return validStart ? formatWorkDuration(Math.max(0, now - startedAt)) : 'Timing unavailable';
}
