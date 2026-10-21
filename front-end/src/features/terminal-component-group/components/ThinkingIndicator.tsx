/**
 * STATE MACHINE: ThinkingIndicator
 *
 * Renders the thinking animation + char counter.
 * Visibility is controlled by parent (thinkingVisible flag).
 *
 * PROPS:
 *   isClaudeStreaming --> swap blue gradient for direct-token orange
 *   streamStartedAtMs --> elapsed timer starts at LLM request start
 *   streamingTokenCount --> drives animated token counter
 */
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { cn } from '@/lib/utils';
import { StreamingMetric } from './StreamingMetric';

// Direct-token orange gradient palette for thinking animation SVG recoloring.
// Warm terracotta tones match the existing Claude-auth side effect.
const CLAUDE_GRADIENT = ['#F5C4A1', '#E8976A', '#D97757', '#CC5B33', '#B84A22', '#9E3A18'];

interface ThinkingIndicatorProps {
  compact: boolean;
  isClaudeStreaming: boolean;
  streamStartedAtMs?: number;
  streamingTokenCount?: number;
  tokensPerSecond?: number;
  label?: 'Thinking' | 'Streaming';
  animatedTokenCount?: number;
}

export function ThinkingIndicator({
  compact,
  isClaudeStreaming,
  streamStartedAtMs,
  streamingTokenCount,
  animatedTokenCount,
  tokensPerSecond,
  label = 'Thinking',
}: ThinkingIndicatorProps) {
  return (
    <div data-testid="thinking-indicator" className={cn('flex', !compact && 'gap-3')}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ThinkingAnimation
            dataUrl="/thinking_animations.txt"
            autoplay
            loop
            className="w-4 h-4 flex-shrink-0"
            style={{ width: '16px', height: '16px' }}
            gradient={isClaudeStreaming ? CLAUDE_GRADIENT : undefined}
          />
          <span className="text-sm font-medium animate-shimmer bg-gradient-to-r bg-[length:200%_100%] bg-clip-text text-transparent from-foreground via-muted-foreground to-foreground">
            {label}
          </span>
          <StreamingMetric
            startedAtMs={streamStartedAtMs}
            tokenCount={streamingTokenCount}
            tokensPerSecond={tokensPerSecond}
            animatedTokenCount={animatedTokenCount}
            className="ml-auto text-xs"
            iconClassName="h-3 w-3"
          />
        </div>
      </div>
    </div>
  );
}

export default ThinkingIndicator;
