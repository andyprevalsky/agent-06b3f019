/**
 * A thought's recorded generation: `metadata.generation` = {output_tokens,
 * started_at, ended_at} written by its producer (the root agent's LLM call usage,
 * or a code session's own usage samples around the thinking record). The thought
 * row and the running work row both read it here: tok/s = recorded output tokens
 * over the recorded window. A thought without one shows no tokens; nothing is
 * estimated from text length.
 */
import type { Message } from '../hooks';
import { eventTimeMs } from '../hooks/codeAgentContract';

export interface ThoughtGeneration {
  outputTokens: number;
  durationMs: number;
  tokensPerSecond: number;
}

export function thoughtGeneration(metadata: Message['metadata']): ThoughtGeneration | null {
  const raw = metadata?.generation;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const {
    output_tokens: tokens,
    started_at: startedAt,
    ended_at: endedAt,
  } = raw as Record<string, unknown>;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null;
  const start = eventTimeMs(startedAt as string | number | undefined);
  const end = eventTimeMs(endedAt as string | number | undefined);
  if (start === null || end === null || end <= start) return null;
  const durationMs = end - start;
  return { outputTokens: tokens, durationMs, tokensPerSecond: tokens / (durationMs / 1000) };
}
