/**
 * One running batch clock; activity carousel updates never reset its recorded start.
 * With no server start yet (a streaming thought has no timestamp) the clock starts
 * optimistically from the client's first render. A server start arriving later is
 * reconciled by keeping that client anchor, so the shown elapsed never jumps or resets.
 */
import { useEffect, useState } from 'react';
import { formatWorkDuration } from '../hooks/codeSessionTurns';

export function useBatchElapsed(startedAt: number | null, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  const validStart = startedAt !== null && Number.isFinite(startedAt) && startedAt > 0;
  const [optimisticStart] = useState(() => (validStart ? null : Date.now()));
  const start = optimisticStart ?? (validStart ? startedAt : now);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running, start]);
  return formatWorkDuration(Math.max(0, now - start));
}
