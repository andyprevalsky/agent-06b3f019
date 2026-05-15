/**
 * STATE MACHINE: StreamingMetric
 *
 * [HIDDEN] startedAtMs missing and tokenCount=0
 *   |
 *   | stream state provides llm_started_at_ms or token count
 *   v
 * [VISIBLE] elapsed seconds count from LLM request start, token count springs in
 *
 * RENDER:
 *   X.Ys · ↓ X tokens
 */

import { ArrowDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface StreamingMetricProps {
  startedAtMs?: number;
  tokenCount: number;
  animatedTokenCount: number;
  className?: string;
  iconClassName?: string;
}

function useElapsedSeconds(startedAtMs?: number) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAtMs) return undefined;

    const interval = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [startedAtMs]);

  if (!startedAtMs) return 0;
  return Math.max(0, (nowMs - startedAtMs) / 1000);
}

export function StreamingMetric({
  startedAtMs,
  tokenCount,
  animatedTokenCount,
  className,
  iconClassName,
}: StreamingMetricProps) {
  const elapsedSeconds = useElapsedSeconds(startedAtMs);

  if (!startedAtMs && tokenCount <= 0) return null;

  return (
    <span
      className={cn(
        'flex flex-shrink-0 items-center tabular-nums text-muted-foreground/55',
        className,
      )}
    >
      {elapsedSeconds.toFixed(1)}s<span className="mx-1 text-muted-foreground/35">·</span>
      <ArrowDown
        aria-hidden="true"
        className={cn('mr-0.5 h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/35', iconClassName)}
      />
      {animatedTokenCount.toLocaleString()} tokens
    </span>
  );
}
