/**
 * Request/option types and the truncation sentinel for response-schema
 * generation (split from setResponseSchema.ts to keep it under max-lines).
 */

/**
 * Parameters for one streaming attempt against Rose Flash.
 *
 * Pulled out so the max_tokens escalation retry (rule E9 — mirror
 * agents/helpers/llm.py:1276-1313) can re-call with a larger budget
 * without duplicating the request shape.
 */
export interface StreamAttemptOptions {
  goal: string;
  maxTokens: number;
  directAuth?: ResponseSchemaDirectAuth;
  archive?: ResponseSchemaArchiveBinding;
}

/** Archive binding for the schema-generation LLM call (agent tree root or per-user root). */
export interface ResponseSchemaArchiveBinding {
  agent_id: string;
  root_agent_id: string;
  extra?: Record<string, unknown>;
  /** Records each stored record path (pre-allocated agent id link; schemaArchiveLinks.ts). */
  on_record?: (objectPath: string) => Promise<void> | void;
}

export interface ResponseSchemaDirectAuth {
  type: 'claude' | 'gpt';
  accessToken: string;
  accountId?: string;
}

/**
 * Sentinel error for "the model hit max_tokens before emitting a complete
 * JSON object." Caller in `generateResponseSchema` catches this and re-runs
 * the stream with 2x max_tokens (one-shot escalation, mirroring
 * call_llm_structured_streaming in agents/helpers/llm.py).
 */
export class MaxTokensTruncationError extends Error {
  readonly maxTokens: number;
  readonly partialContent: string;
  constructor(maxTokens: number, partialContent: string) {
    super(`Schema-gen response truncated at max_tokens=${maxTokens} (finish_reason=length)`);
    this.name = 'MaxTokensTruncationError';
    this.maxTokens = maxTokens;
    this.partialContent = partialContent;
  }
}
