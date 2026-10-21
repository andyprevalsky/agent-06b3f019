/** One running batch clock; activity carousel updates never reset its recorded start. */
import { useEffect, useState } from 'react';
import { formatWorkDuration } from '../hooks/codeSessionTurns';

export function useBatchElapsed(startedAt: number | null, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  const validStart = startedAt !== null && Number.isFinite(startedAt) && startedAt > 0;
  useEffect(() => {
    if (!running || !validStart) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running, validStart, startedAt]);
  return validStart ? formatWorkDuration(Math.max(0, now - startedAt)) : 'Timing unavailable';
}
