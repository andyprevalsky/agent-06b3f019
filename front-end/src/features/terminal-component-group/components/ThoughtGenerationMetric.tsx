/** "<duration> · ↓ <tokens> tokens · <rate> tok/s" for a thought's recorded generation. */
import { StreamingMetric } from './StreamingMetric';
import type { ThoughtGeneration } from './thoughtGeneration';

export function ThoughtGenerationMetric({ generation }: { generation: ThoughtGeneration }) {
  return (
    <StreamingMetric
      durationMs={generation.durationMs}
      tokenCount={generation.outputTokens}
      tokensPerSecond={generation.tokensPerSecond ?? undefined}
      className="text-xs"
      iconClassName="h-3 w-3"
    />
  );
}
