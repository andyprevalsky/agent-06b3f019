/**
 * Shared types for the Rose client.
 *
 * Mirrors agents/providers/rose/types.py — same chunk shape so the FE/BE
 * speaks one vocabulary across the Python and TypeScript stacks.
 *
 * The chunk envelope (CompletionChunk) is the OpenAI-shaped DTO that chat
 * callers iterate. RoseStreamChunk is the typed normalized form used inside
 * the orchestration layer.
 */
import type { AgentSpeed } from './speed';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentBlock {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
  detail?: string;
  file?: { filename: string; file_data: string };
}

export interface CompletionMessage {
  role: MessageRole;
  content: string | ContentBlock[];
  tool_call_id?: string;
  call_id?: string;
  tool_calls?: Array<{
    id?: string;
    call_id?: string;
    /**
     * OpenAI's discriminator. Cerebras and strict OpenRouter validators (e.g.
     * Google) reject assistant tool_calls that omit it; Anthropic tolerated
     * absence, so the bug only surfaces off the Anthropic path.
     */
    type?: 'function';
    name?: string;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }>;
  codex_reasoning_items?: Array<Record<string, unknown>>;
  codex_message_items?: Array<Record<string, unknown>>;
}

export interface ResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
}

export interface CompletionOptions {
  model: string;
  messages: CompletionMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: ResponseFormat;
  response_model?: import('./schema').ZodResponseModel;
  tools?: Array<Record<string, unknown>>;
  /** Internal Anthropic compatibility schemas; body builders never serialize this field. */
  anthropic_tools?: Array<Record<string, unknown>>;
  /** Derived Cerebras dialect tools; explicit caller tools are never projected. */
  cerebras_tools?: Array<Record<string, unknown>>;
  /** Identity binding: replacing generic tools invalidates the derived dialect. */
  cerebras_tools_source?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  effort?: string;
  /**
   * Provider speed forwarded to every leg (speed.ts). Omitted = standard:
   * no Claude fast mode and no service tier on any GPT/Azure leg.
   */
  speed?: AgentSpeed;
  /** Stable agent or user identity for distributing Foundry requests. */
  route_key?: string;
  /**
   * Selects an exclusive provider path. Omitted requests keep the normal
   * OAuth -> shared keys -> OpenRouter Rose routing contract.
   */
  provider_route?:
    'direct-cerebras' | 'openrouter-cerebras' | 'shared-openai-priority' | 'openrouter-waterfall';
  /** Internal cancellation used by bounded provider hedges; never serialized. */
  abort_signal?: AbortSignal;
  claude_token?: string;
  gpt_token?: string;
  gpt_account_id?: string;
  /**
   * Internal, never serialized. Supplies further subscription credentials
   * (Claude/Codex leases) inside this call. The client consults it only when a
   * subscription leg fails with a usage-limit, out-of-credits or auth signal, or
   * once for the first lease when no token was passed. Every subscription is
   * tried before any funded key (OpenAI/Anthropic API key, Foundry).
   */
  subscription_leases?: SubscriptionLeases;
  /**
   * Identifies WHICH grant supplied `claude_token`/`gpt_token`, so a revocation
   * observed here can be healed rather than merely reported.
   *
   * Optional on purpose: without it a revoked grant falls through to the
   * waterfall exactly as before, so un-migrated callers keep working. With it,
   * the completion path mints a replacement and retries on the subscription
   * instead of silently spending money on paid models.
   */
  compute_grant?: {
    userId: string;
    provider: 'claude' | 'codex';
    accountId: string;
    grantId?: string;
  };
  disable_waterfall?: boolean;
  dump_context?: {
    call_site: string;
    agent_id?: string;
    config?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  };
}

/** One subscription credential: a Claude or ChatGPT/Codex OAuth access token. */
export interface SubscriptionCredential {
  type: 'claude' | 'gpt';
  accessToken: string;
  accountId?: string;
}

/** Why a subscription leg stopped serving, from the typed Rose error. */
export interface SubscriptionLeaseFailure {
  credential: SubscriptionCredential;
  reason: 'auth_error' | 'rate_limit';
  /** The provider's own reset time, when it gave one. */
  rateLimitedUntil?: string;
}

/**
 * In-call source of subscription credentials. `next(null)` leases the first
 * credential; `next(failure)` marks the failed credential unavailable and leases
 * one not yet tried in this call. Returns null when none remain.
 */
export interface SubscriptionLeases {
  next(failure: SubscriptionLeaseFailure | null): Promise<SubscriptionCredential | null>;
}

/**
 * SSE chunk shape Rose chat callers consume. Identical to what the deleted
 * Supabase edge function emitted, so callers can be repointed without
 * touching their iteration logic.
 */
export interface CompletionChunk {
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      reasoning?: string;
      role?: string;
      item_id?: string;
      output_index?: number;
      content_index?: number;
      phase?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  requested_model: string;
  actual_model: string;
  pool_name: string;
  pool_size: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  codex_reasoning_item?: Record<string, unknown>;
}

/**
 * Internal normalized stream chunk — analogous to the Python StreamChunk.
 * Producers (claudeAuth/waterfall + parsers) yield these; the client wraps
 * them into the OpenAI-shaped CompletionChunk for chat callers.
 */
export type ChunkKind =
  'metadata' | 'content' | 'tool_call' | 'reasoning' | 'codex_reasoning_item' | 'usage' | 'done';

export interface OutputProvenance {
  item_id: string;
  output_index: number;
  content_index: number;
  phase: string;
}

export type RoseStreamChunk =
  | {
      kind: 'metadata';
      data: { actual_model: string; pool_name: string; request_id: string };
    }
  | { kind: 'content'; data: { text: string } & OutputProvenance }
  | { kind: 'reasoning'; data: { text: string } & OutputProvenance }
  | { kind: 'tool_call'; data: { id: string; name: string; arguments: string } }
  | { kind: 'codex_reasoning_item'; data: Record<string, unknown> }
  | {
      kind: 'usage';
      data: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        finish_reason?: string;
      };
    }
  | { kind: 'done'; data: Record<string, never> };
