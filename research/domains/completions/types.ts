/**
 * Completions Domain Types
 *
 * All interfaces, type aliases, and shared type contracts used across the
 * completions Supabase edge function (Rose model racing).
 *
 * Canonical SSE streaming chunk shape (RoseCompletionChunk) must stay in sync
 * with consumers: agents/helpers/llm.py and
 * back-end/src/lib/chat/supabaseCompletions.ts.
 */

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

/**
 * Loose Supabase client type used by the repo layer.
 *
 * We only depend on `from(...)` and `rpc(...)` and don't want to pin the
 * domain to `@supabase/supabase-js`'s generic typing, so this stays as a
 * structural `any`. The repo layer surfaces typed results to callers.
 */
// deno-lint-ignore no-explicit-any
export type SupabaseClient = any;

// ---------------------------------------------------------------------------
// Canonical SSE chunk shape
// ---------------------------------------------------------------------------

export interface RoseCompletionChunk {
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      reasoning?: string;
      role?: string;
    };
    finish_reason?: string | null;
  }>;
  requested_model: string;
  actual_model: string;
  pool_name: string;
  pool_size: number;
  claude_token_error?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Browser-use types
// ---------------------------------------------------------------------------

export interface BrowserState {
  url: string;
  title?: string;
  dom_tree: string;
  screenshot?: string;
  viewport: { width: number; height: number };
  scroll_position: {
    x: number;
    y: number;
    pages_above?: number;
    pages_below?: number;
    total_pages?: number;
  };
  tabs?: { id: string; url: string; title: string }[];
  page_stats?: {
    links: number;
    interactive: number;
    iframes: number;
    scroll_containers: number;
    images: number;
    total_elements: number;
  };
  recent_events?: string[];
  closed_popups?: string[];
}

export interface ActionHistoryEntry {
  step: number;
  thinking?: string;
  action: string;
  index?: number;
  coordinates?: { x: number; y: number };
  element_description?: string;
  // deno-lint-ignore no-explicit-any
  params?: Record<string, any>;
  result: { success: boolean; error?: string; error_type?: string };
  screenshot?: string;
}

export interface BrowserUseRequest {
  model: string;
  task: string;
  browser_state: BrowserState;
  action_history: ActionHistoryEntry[];
  available_actions: string[];
  model_seed?: number;
  mode?: 'default' | 'claude';
  user_id?: string;
  oauth_token?: string;
}

export interface UnifiedAction {
  action: string;
  thinking?: string;
  index?: number;
  coordinates?: { x: number; y: number };
  element_description?: string;
  // deno-lint-ignore no-explicit-any
  params?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Racing / routing types
// ---------------------------------------------------------------------------

export interface RacingModel {
  model: string;
  latencyMs: number;
  delayMs: number;
}

/** Racing configuration (overridable for browser-use completion racing). */
export interface RacingConfig {
  maxLatencyCapMs: number;
  maxDelayCapMs: number;
  defaultLatencyMs: number;
  trioSize: number;
}

export interface LatencyEntry {
  model: string;
  pool: string;
  latencyMs: number;
  measuredAt: Date;
}

export type ModelPreference = 'SMART' | 'FAST' | 'CHEAP';
