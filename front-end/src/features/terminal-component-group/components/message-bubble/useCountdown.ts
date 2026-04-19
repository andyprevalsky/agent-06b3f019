/**
 * Tracks the remaining seconds on an auto-simulation countdown.
 *
 * STATE MACHINE:
 *   [INACTIVE]  <-- status !== IN_PROGRESS || !timeout || !startTime -> null
 *      |
 *      | (transition into IN_PROGRESS with timeout + startTime)
 *      v
 *   [TICKING]   <-- updates once per second until remaining <= 0
 *      |
 *      v
 *   [EXPIRED]   <-- 0, interval cleared
 */
import { useEffect, useState } from 'react';

interface UseCountdownArgs {
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  timeout?: number;
  startTime?: string;
}

export function useCountdown({ status, timeout, startTime }: UseCountdownArgs): number | null {
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (status !== 'IN_PROGRESS' || !timeout || !startTime) {
      setCountdownSeconds(null);
      return;
    }

    const calculateRemaining = () => {
      const started = new Date(startTime).getTime();
      const elapsed = (Date.now() - started) / 1000;
      return Math.ceil(Math.max(0, timeout - elapsed));
    };

    setCountdownSeconds(calculateRemaining());

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setCountdownSeconds(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [status, timeout, startTime]);

  return countdownSeconds;
}
