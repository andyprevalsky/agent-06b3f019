/**
 * A thought's recorded generation: `metadata.generation` = {output_tokens,
 * started_at, ended_at} written by its producer (the root agent's LLM call usage,
 * or a code session's own usage samples around the thinking record). The thought
 * row and the running work row both read it here: tok/s = recorded output tokens
 * over the recorded window. A thought without one shows no tokens; nothing is
 * estimated from text length.
 *
 * The figures belong to the whole model call that produced the thought (its text
 * plus tool-call arguments), not to the thought text alone. Root windows run first
 * token → last token; Claude Code windows run message_start → message_delta (they
 * include time to first token, so they read as a lower bound).
 *
 * This is the ONE judge of what a recording can show, for both producers. A response a
 * gateway returned in a single burst (an unstreamed route) has a window of milliseconds
 * around all of its tokens: the implied rate is no streaming speed, so it is returned as
 * not measurable, with its tokens and duration but no rate. The bound is exported once and
 * the benchmark check imports it. The stored shape is unchanged, so rows recorded before
 * this judge existed render as they did, and absurd ones are now caught on read.
 */
import type { Message } from '../hooks';
import { eventTimeMs } from '../hooks/codeAgentContract';

/**
 * The fastest rate a STREAMED response plausibly reaches (the quickest provider streams
 * ~3,000 tok/s). A recorded window implying more was not streamed.
 */
export const MAX_STREAMING_TOKENS_PER_SECOND = 5_000;

export const BURST_REASON = 'response arrived in one burst, not streamed';

export interface ThoughtGeneration {
  outputTokens: number;
  durationMs: number;
  /** null for a burst: there is no streaming rate to show. */
  tokensPerSecond: number | null;
  /** Set (to BURST_REASON) when the recording is not a measurable streaming rate. */
  notMeasurable?: typeof BURST_REASON;
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
  const tokensPerSecond = tokens / (durationMs / 1000);
  if (tokensPerSecond > MAX_STREAMING_TOKENS_PER_SECOND)
    return { outputTokens: tokens, durationMs, tokensPerSecond: null, notMeasurable: BURST_REASON };
  return { outputTokens: tokens, durationMs, tokensPerSecond };
}
