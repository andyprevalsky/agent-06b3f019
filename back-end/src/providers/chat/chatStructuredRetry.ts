/**
 * Bounded in-place regenerate for chat structured-output misses.
 *
 * SMS (2026-07-19) and the agent helper (MAX_STRUCTURED_PARSE_RETRIES)
 * already treat empty / reasoning-only / unparseable streams as a
 * regenerate condition — never a crash, never an immediate apology.
 * Chat router/generator used to throw on the first miss, and create-agent
 * mapped that throw to FAILED.
 *
 * Each attempt keeps its own 3s router completion bound. This is not a
 * bound relaxation: a miss starts a new attempt, it does not stretch the
 * first one.
 */

import { createLogger } from '../logger';

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
      if (!isChatLlmTransientMiss(error)) throw error;
      lastMiss = error;
      log.warn('[ChatStructuredRetry] Transient structured-output miss; regenerating', {
        callSite: params.callSite,
        agentId: params.agentId,
        kind: error.kind,
        attempt,
        attempts: MAX_CHAT_STRUCTURED_ATTEMPTS,
        error: error.message,
      });
      if (attempt === MAX_CHAT_STRUCTURED_ATTEMPTS) throw error;
    }
  }
  throw (
    lastMiss ?? new ChatLlmTransientMissError('empty', 'Chat structured output miss after retries')
  );
}
