import { useState, useEffect, memo } from 'react';

/**
 * Ticks every second to show elapsed time (m:ss) since `startedAt`.
 */
export const CallTimer = memo(function CallTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startTime = new Date(startedAt).getTime();

    const updateElapsed = () => {
      const now = Date.now();
      setElapsed(Math.floor((now - startTime) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [startedAt]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <span className="tabular-nums font-mono text-sm">
      {minutes}:{seconds.toString().padStart(2, '0')}
    </span>
  );
});
