/**
 * Bounded in-place regenerate for chat structured-output misses.
 *
 * SMS (2026-07-19) and the agent helper (MAX_STRUCTURED_PARSE_RETRIES)
 * already treat empty / reasoning-only / unparseable streams as a
 * regenerate condition — never a crash, never an immediate apology.
 * Chat router/generator used to throw on the first miss, and create-agent
 * mapped that throw to FAILED.
 *
 * Each attempt keeps its own router deadline; a miss starts a new attempt,
 * it does not stretch the first one.
 *
 * Deadline misses regenerate like every other miss. Prod agent e8f2279b
 * (2026-10-01): the Cerebras router stalled, the first attempt's deadline
 * fired, and answering it with an apology instead of a second attempt
 * (which re-races Cerebras and the OpenRouter failover) gave up on a
 * recoverable turn.
 */

import { createLogger } from '../logger';
import { StructuredOutputCardinalityError } from '../rose/structuredOutput';

const log = createLogger('ChatStructuredRetry');

export const MAX_CHAT_STRUCTURED_ATTEMPTS = 2;

export type ChatLlmTransientMissKind = 'empty' | 'parse' | 'deadline';

export class ChatLlmTransientMissError extends Error {
  readonly code = 'CHAT_LLM_TRANSIENT_MISS';
  readonly kind: ChatLlmTransientMissKind;

  constructor(kind: ChatLlmTransientMissKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatLlmTransientMissError';
    this.kind = kind;
  }
}

export function isChatLlmTransientMiss(error: unknown): error is ChatLlmTransientMissError {
  return error instanceof ChatLlmTransientMissError;
}

function asChatStructuredMiss(error: unknown): ChatLlmTransientMissError | null {
  if (isChatLlmTransientMiss(error)) return error;
  if (error instanceof StructuredOutputCardinalityError) {
    return new ChatLlmTransientMissError('empty', error.message, { cause: error });
  }
  return null;
}

export async function regenerateOnChatStructuredMiss<T>(params: {
  callSite: 'chat_router' | 'chat_generator';
  agentId: string;
  attempt: (attempt: number) => Promise<T>;
}): Promise<T> {
  let lastMiss: ChatLlmTransientMissError | undefined;
  for (let attempt = 1; attempt <= MAX_CHAT_STRUCTURED_ATTEMPTS; attempt += 1) {
    try {
      return await params.attempt(attempt);
    } catch (error) {
      const miss = asChatStructuredMiss(error);
      if (!miss) throw error;
      lastMiss = miss;
      const exhausted = attempt === MAX_CHAT_STRUCTURED_ATTEMPTS;
      log.warn(
        exhausted
          ? '[ChatStructuredRetry] Transient structured-output miss; regenerate budget exhausted'
          : '[ChatStructuredRetry] Transient structured-output miss; regenerating',
        {
          callSite: params.callSite,
          agentId: params.agentId,
          kind: miss.kind,
          attempt,
          attempts: MAX_CHAT_STRUCTURED_ATTEMPTS,
          error: miss.message,
        }
      );
      if (exhausted) throw miss;
    }
  }
  throw (
    lastMiss ?? new ChatLlmTransientMissError('empty', 'Chat structured output miss after retries')
  );
}
