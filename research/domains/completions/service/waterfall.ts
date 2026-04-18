/**
 * Waterfall streaming: sequential model fallback.
 *
 * Unlike trio racing (which fires all models in parallel), waterfall streams
 * the first model and falls through to the next on 4xx/5xx or timeout. Used
 * for pools where we'd rather pay for ONE model's input tokens per request
 * than race three. On success, saves the winner as the conversation-pinned
 * model and returns its stream as-is.
 */

// deno-lint-ignore-file no-explicit-any

import { slog } from '../../../providers/logger.ts';
import type { SupabaseClient } from '../types.ts';
import { corsHeaders, WATERFALL_TIMEOUT_MS } from '../config.ts';
import { saveConversationModel } from '../repo.ts';
import { withTimeout } from '../utils.ts';
import { handleStreaming } from './streaming.ts';

/**
 * Try each model in the pool sequentially. Stream the first one that returns
 * a 2xx. If all fail, return a 500 with the collected error messages.
 */
export async function waterfallStream(
  pool: string[],
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any,
  reasoning: { max_tokens?: number } | undefined,
  openRouterKey: string,
  supabaseUrl: string,
  requestedModel: string,
  poolName: string,
  poolSize: number,
  conversation_id: string | null,
  supabase: SupabaseClient,
  claudeTokenError?: string,
): Promise<Response> {
  const errors: string[] = [];

  for (let i = 0; i < pool.length; i++) {
    const model = pool[i];
    const isLast = i === pool.length - 1;
    slog('info', `Waterfall [${i + 1}/${pool.length}]: trying ${model}`);

    try {
      // deno-lint-ignore no-await-in-loop -- waterfall is sequential by design
      const response = await withTimeout(
        handleStreaming(
          model,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          toolChoice,
          responseFormat,
          reasoning,
          openRouterKey,
          supabaseUrl,
          requestedModel,
          false, // isCerebras
          poolName,
          poolSize,
          undefined,
          undefined,
          undefined, // claudeAuth, skipCache, stallConfig
          claudeTokenError,
        ),
        WATERFALL_TIMEOUT_MS,
        `waterfall-${model}`,
      );

      // handleStreaming returns a Response — check if it's an error status
      if (!response.ok) {
        // deno-lint-ignore no-await-in-loop -- waterfall is sequential by design
        const errText = await response.text().catch(() => 'unknown');
        const msg = `${model} returned ${response.status}: ${errText.slice(0, 200)}`;
        slog('warn', `Waterfall: ${msg}`);
        errors.push(msg);
        continue;
      }

      slog('info', `Waterfall winner: ${model} (attempt ${i + 1}/${pool.length})`);

      // Save winning model for conversation
      if (conversation_id) {
        // deno-lint-ignore no-await-in-loop -- waterfall is sequential by design
        await saveConversationModel(supabase, conversation_id, model, poolName);
      }

      return response;
    } catch (err: any) {
      const msg = `${model} failed: ${err.message || err}`;
      slog('warn', `Waterfall: ${msg}`);
      errors.push(msg);

      if (!isLast) {
        slog('info', `Waterfall: falling through to next model`);
      }
    }
  }

  // All models failed
  slog('error', `Waterfall: all ${pool.length} models failed`, { data: errors });
  return new Response(
    JSON.stringify({
      error: 'All waterfall models failed',
      details: errors,
    }),
    {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    },
  );
}
