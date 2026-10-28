/**
 * STATE MACHINE: StreamingMetric
 *
 * [HIDDEN] startedAtMs missing and tokenCount=0 (unless showZeroTokens)
 *   |
 *   | stream state provides llm_started_at_ms or token count
 *   v
 * [VISIBLE] elapsed seconds count from LLM request start, token count springs in
 *
 * showZeroTokens (Thinking): a known count is on screen from the first frame,
 *   reading ↓ 0 before the first byte and springing up as tokens arrive. An
 *   unknown count (undefined) is never invented.
 *
 * RENDER:
 *   X.Ys · ↓ X tokens   (no start: ↓ X tokens)
 */

import { ArrowDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface StreamingMetricProps {
  startedAtMs?: number;
  tokenCount?: number;
  animatedTokenCount?: number;
  tokensPerSecond?: number;
  className?: string;
  iconClassName?: string;
  showZeroTokens?: boolean;
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
  tokensPerSecond,
  className,
  iconClassName,
  showZeroTokens = false,
}: StreamingMetricProps) {
  const elapsedSeconds = useElapsedSeconds(startedAtMs);

  const hasTokens =
    typeof tokenCount === 'number' && Number.isFinite(tokenCount) && tokenCount >= 0;
  const hasRate =
    typeof tokensPerSecond === 'number' && Number.isFinite(tokensPerSecond) && tokensPerSecond >= 0;
  const zeroTokensShown = showZeroTokens && hasTokens;
  if (!startedAtMs && !(hasTokens && tokenCount > 0) && !hasRate && !zeroTokensShown) return null;
  // No request start: a Thinking counter shows tokens alone, never a frozen 0.0s clock.
  const showClock = Boolean(startedAtMs) || (hasTokens && !showZeroTokens);

  return (
    <span
      className={cn(
        'flex flex-shrink-0 items-center tabular-nums text-muted-foreground/55',
        className,
      )}
    >
      {showClock && <>{elapsedSeconds.toFixed(1)}s</>}
      {hasTokens && (
        <>
          {showClock && <span className="mx-1 text-muted-foreground/35">·</span>}
          <ArrowDown
            aria-hidden="true"
            className={cn(
              'mr-0.5 h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/35',
              iconClassName,
            )}
          />
          {(animatedTokenCount ?? tokenCount).toLocaleString()} tokens
        </>
      )}
      {hasRate && (
        <>
          <span className="mx-1 text-muted-foreground/35">·</span>
          {tokensPerSecond.toFixed(1)} tok/s
        </>
      )}
    </span>
  );
}
