/**
 * Trio-racing streaming sub-flow.
 *
 * The default streaming path for pools NOT configured for waterfall. Selects a
 * trio of models based on cached latencies, fires latency probes in parallel
 * if the cache is stale, races the trio via `raceModels`, and streams the
 * winning model's response to the client.
 *
 * The stream body transforms provider-specific SSE events to the OpenAI
 * streaming format: Anthropic `content_block_delta` events become OpenAI
 * `choices[].delta.content` chunks, with a final usage chunk synthesized from
 * `message_start` / `message_delta` counters. OpenRouter / Cerebras pass
 * through with metadata (requested_model, actual_model, pool_name,
 * racing_ttft_ms, models_raced, timings) and cache-field translation.
 */

// deno-lint-ignore-file no-explicit-any

import type { SupabaseClient } from 'npm:@supabase/supabase-js@~2.39.3';

import { corsHeaders } from '../config.ts';
import { slog } from '../utils.ts';
import { saveConversationModel } from '../repo.ts';
import { isAnthropicModel } from './anthropic.ts';
import { fireLatencyProbes } from './generic.ts';
import { raceModels, selectRacingTrio } from './racing.ts';
import { handleStreaming } from './streaming.ts';

export interface TrioStreamParams {
  effectivePool: string[];
  pool: string[];
  poolName: string;
  messages: any[];
  temperature: number | undefined;
  maxTokens: number | undefined;
  seed: number | undefined;
  tools: any;
  tool_choice: any;
  response_format: any;
  reasoning: any;
  cappedReasoning: any;
  openRouterKey: string;
  supabaseUrl: string;
  model: string;
  conversation_id: string | undefined;
  supabase: SupabaseClient;
  cachedLatencies: Map<string, number>;
  needsRefresh: boolean;
  missingModels: string[];
  claudeTokenError: string | undefined;
}

/**
 * Run the trio-racing flow: fire latency probes if needed, select a trio,
 * race, then stream the winner back to the client. Returns a ready-to-send
 * `Response`. Never throws — falls back to a random model on failure.
 */
export async function runTrioRaceStream(params: TrioStreamParams): Promise<Response> {
  const {
    effectivePool,
    pool,
    poolName,
    messages,
    temperature,
    maxTokens,
    seed,
    tools,
    tool_choice,
    response_format,
    reasoning,
    cappedReasoning,
    openRouterKey,
    supabaseUrl,
    model,
    conversation_id,
    supabase,
    cachedLatencies,
    needsRefresh,
    missingModels,
    claudeTokenError,
  } = params;

  // ===== TIMING INSTRUMENTATION =====
  const timings: { [key: string]: number } = {};
  const raceStartTime = Date.now();
  timings.race_start = 0;

  // If cache is stale/missing, fire latency probes in PARALLEL with the race
  // Probes use a standard test prompt, not the user's messages
  let _probePromise: Promise<void> | null = null;
  if (needsRefresh && missingModels.length > 0) {
    slog(
      'info',
      `Cache needs refresh, firing probes in parallel for: ${missingModels.join(', ')}`,
    );
    // Fire probes in background - don't await, let them run alongside the race
    _probePromise = fireLatencyProbes(
      missingModels,
      poolName,
      openRouterKey,
      supabaseUrl,
      supabase,
    );
    timings.probes_fired = missingModels.length;
  } else {
    timings.probes_fired = 0;
  }

  // Select racing trio with delays (using current cached values, even if stale)
  const trioSelectStart = Date.now();
  const racingTrio = selectRacingTrio(effectivePool, cachedLatencies);
  timings.trio_select_ms = Date.now() - trioSelectStart;
  slog('info', `TIMING: trio_select=${timings.trio_select_ms}ms`);

  if (racingTrio.length === 0) {
    return new Response(JSON.stringify({ error: 'No eligible models in pool' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }

  // If only one model eligible, skip racing
  if (racingTrio.length === 1) {
    const singleModel = racingTrio[0].model;
    slog('info', `Single model eligible, skipping race: ${singleModel}`);

    if (conversation_id) {
      await saveConversationModel(supabase, conversation_id, singleModel, poolName);
    }

    return await handleStreaming(
      singleModel,
      messages,
      temperature,
      maxTokens,
      seed,
      tools,
      tool_choice,
      response_format,
      reasoning,
      openRouterKey,
      supabaseUrl,
      model,
      false,
      poolName,
      pool.length,
      undefined,
      undefined,
      undefined, // claudeAuth, skipCache, stallConfig
      claudeTokenError,
    );
  }

  // Race the trio!
  try {
    const raceCallStart = Date.now();
    timings.race_call_start_ms = raceCallStart - raceStartTime;
    slog(
      'info',
      `TIMING: race_call_start=${timings.race_call_start_ms}ms (time before raceModels)`,
    );

    const { model: winningModel, reader: winningReader, ttftMs, firstData } = await raceModels(
      racingTrio,
      messages,
      temperature,
      maxTokens,
      seed,
      tools,
      tool_choice,
      response_format,
      reasoning,
      openRouterKey,
      supabaseUrl,
      supabase,
      poolName,
      timings,
    );

    timings.race_complete_ms = Date.now() - raceStartTime;
    timings.race_duration_ms = Date.now() - raceCallStart;
    slog(
      'info',
      `TIMING: race_complete=${timings.race_complete_ms}ms, race_duration=${timings.race_duration_ms}ms`,
    );

    // Save winning model for conversation
    if (conversation_id) {
      await saveConversationModel(supabase, conversation_id, winningModel, poolName);
    }

    // Stream the winning response to client
    const streamStartTime = Date.now();
    timings.stream_start_ms = streamStartTime - raceStartTime;
    slog('info', `TIMING: stream_start=${timings.stream_start_ms}ms`);

    const stream = buildWinnerStream({
      winningModel,
      winningReader,
      ttftMs,
      firstData,
      modelsRaced: racingTrio.length,
      streamStartTime,
      timings,
      model,
      poolName,
      poolSize: pool.length,
      claudeTokenError,
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    slog('error', 'Trio racing failed:', { data: error });

    // Fallback to random model
    const fallbackModel = pool[Math.floor(Math.random() * pool.length)];
    slog('info', `Falling back to random model: ${fallbackModel}`);

    return await handleStreaming(
      fallbackModel,
      messages,
      temperature,
      maxTokens,
      seed,
      tools,
      tool_choice,
      response_format,
      cappedReasoning,
      Deno.env.get('OPENROUTER_API_KEY') ?? '',
      supabaseUrl,
      model,
      false,
      poolName,
      pool.length,
      undefined,
      undefined,
      undefined, // claudeAuth, skipCache, stallConfig
      claudeTokenError,
    );
  }
}

interface WinnerStreamParams {
  winningModel: string;
  winningReader: ReadableStreamDefaultReader<Uint8Array>;
  ttftMs: number;
  firstData: string;
  modelsRaced: number;
  streamStartTime: number;
  timings: { [key: string]: number };
  model: string;
  poolName: string;
  poolSize: number;
  claudeTokenError: string | undefined;
}

/**
 * Wraps the winning model's SSE reader in a ReadableStream that transforms
 * provider-specific events to OpenAI format and injects racing metadata on
 * every chunk. Synthesizes a final usage chunk for Anthropic models.
 */
function buildWinnerStream(params: WinnerStreamParams): ReadableStream<Uint8Array> {
  const {
    winningModel,
    winningReader,
    ttftMs,
    firstData,
    modelsRaced,
    streamStartTime,
    timings,
    model,
    poolName,
    poolSize,
    claudeTokenError,
  } = params;

  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller): Promise<void> {
      try {
        // Use the reader we already have from the race (can't call getReader twice!)
        const reader = winningReader;
        const decoder = new TextDecoder();
        // Start with the buffer we already read during racing
        let buffer = firstData;
        let firstEnqueueTime: number | null = null;

        // Anthropic usage tracking - capture from message_start and message_delta
        let anthropicInputTokens = 0;
        let anthropicOutputTokens = 0;
        let anthropicCacheCreationTokens = 0;
        let anthropicCacheReadTokens = 0;

        // Process the firstData buffer immediately
        slog('info', `TIMING: processing firstData buffer (${firstData.length} chars)`);

        // Helper to process buffer lines
        const processBuffer = () => {
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          return lines;
        };

        // Helper to process a single line
        const processLine = (line: string) => {
          // Handle both "data: " (with space) and "data:" (no space) formats
          if (line.startsWith('data:')) {
            // Extract data after "data:" - handle optional space
            const data = line.startsWith('data: ') ? line.slice(6) : line.slice(5).trim();
            if (data === '[DONE]') {
              return;
            }

            try {
              const parsed = JSON.parse(data);

              // Transform Anthropic streaming events to OpenAI format (same as handleStreaming)
              if (isAnthropicModel(winningModel)) {
                // Capture input tokens and cache metrics from message_start
                if (parsed.type === 'message_start') {
                  if (parsed.message?.usage) {
                    const msgUsage = parsed.message.usage;
                    anthropicInputTokens = msgUsage.input_tokens || 0;
                    anthropicCacheCreationTokens = msgUsage.cache_creation_input_tokens || 0;
                    anthropicCacheReadTokens = msgUsage.cache_read_input_tokens || 0;
                    slog(
                      'info',
                      `Anthropic input_tokens=${anthropicInputTokens}, cache_read=${anthropicCacheReadTokens}, cache_write=${anthropicCacheCreationTokens}`,
                    );
                  }
                  return;
                }

                // Capture output tokens from message_delta
                if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
                  anthropicOutputTokens = parsed.usage.output_tokens;
                  slog('info', `Anthropic output_tokens captured: ${anthropicOutputTokens}`);
                  return;
                }

                // Skip other non-content events (content_block_start, etc.)
                if (parsed.type !== 'content_block_delta') {
                  return;
                }

                // Transform to OpenAI format
                const openAIFormat: any = {
                  choices: [{
                    index: 0,
                    delta: {
                      content: parsed.delta?.text || parsed.delta?.partial_json || '',
                    },
                  }],
                  requested_model: model,
                  actual_model: winningModel,
                  pool_name: poolName,
                  pool_size: poolSize,
                  racing_ttft_ms: ttftMs,
                  models_raced: modelsRaced,
                  ...(claudeTokenError && { claude_token_error: claudeTokenError }),
                };

                // Track first enqueue timing
                if (firstEnqueueTime === null) {
                  firstEnqueueTime = Date.now() - streamStartTime;
                  timings.first_enqueue_to_client_ms = firstEnqueueTime;
                  slog('info', `TIMING: first_enqueue_to_client=${firstEnqueueTime}ms`);
                }
                openAIFormat.timings = timings;

                const payload = `data: ${JSON.stringify(openAIFormat)}\n\n`;
                controller.enqueue(encoder.encode(payload));
                return;
              }

              // Non-Anthropic models (OpenRouter/Cerebras) - pass through with metadata
              // Skip chunks with empty/missing choices (OpenRouter debug/echo chunks)
              if (!parsed.choices?.length) {
                return;
              }
              parsed.requested_model = model;
              parsed.actual_model = winningModel;
              parsed.pool_name = poolName;
              parsed.pool_size = poolSize;
              parsed.racing_ttft_ms = ttftMs;
              parsed.models_raced = modelsRaced;
              if (claudeTokenError) parsed.claude_token_error = claudeTokenError;

              // Track first enqueue timing
              if (firstEnqueueTime === null) {
                firstEnqueueTime = Date.now() - streamStartTime;
                timings.first_enqueue_to_client_ms = firstEnqueueTime;
                slog('info', `TIMING: first_enqueue_to_client=${firstEnqueueTime}ms`);
              }
              parsed.timings = timings;

              // Translate OpenRouter cache fields to canonical Anthropic format
              if (parsed.usage?.prompt_tokens_details) {
                const details = parsed.usage.prompt_tokens_details;
                const cachedTokens = details.cached_tokens || 0;
                const cacheWriteTokens = details.cache_write_tokens || 0;

                // Set canonical fields
                parsed.usage.cache_read_input_tokens = cachedTokens;
                parsed.usage.cache_creation_input_tokens = cacheWriteTokens;

                // Adjust prompt_tokens to Anthropic semantics (exclude cached tokens)
                // OpenRouter prompt_tokens is total (incl cached); Anthropic is non-cached only
                parsed.usage.prompt_tokens = Math.max(
                  0,
                  parsed.usage.prompt_tokens - cachedTokens - cacheWriteTokens,
                );

                slog(
                  'info',
                  `Cache translated: read=${cachedTokens}, write=${cacheWriteTokens}, uncached=${parsed.usage.prompt_tokens}`,
                );
              }

              // Adjust usage to reflect TRUE cost (all racing models consumed input tokens)
              if (parsed.usage && parsed.usage.prompt_tokens) {
                const winnerPromptTokens = parsed.usage.prompt_tokens;
                const winnerCompletionTokens = parsed.usage.completion_tokens || 0;
                parsed.usage.prompt_tokens = winnerPromptTokens * modelsRaced;
                parsed.usage.total_tokens = parsed.usage.prompt_tokens +
                  winnerCompletionTokens;
                // Preserve cache fields (NOT multiplied — only winner had cache hits)
                // cache_read_input_tokens and cache_creation_input_tokens stay as-is
                slog(
                  'info',
                  `Usage adjusted: ${winnerPromptTokens} input × ${modelsRaced} models = ${parsed.usage.prompt_tokens} total input tokens`,
                );
              }

              const payload = `data: ${JSON.stringify(parsed)}\n\n`;
              controller.enqueue(encoder.encode(payload));
            } catch (_e) {
              controller.enqueue(encoder.encode(`${line}\n`));
            }
          }
        };

        // Process any complete lines already in firstData buffer
        let lines = processBuffer();
        for (const line of lines) {
          processLine(line);
        }

        // Continue reading from the stream
        while (true) {
          // deno-lint-ignore no-await-in-loop -- SSE stream reads are sequential by design
          const { done, value } = await reader.read();

          if (done) {
            // For Anthropic models, emit final usage chunk before [DONE]
            if (
              isAnthropicModel(winningModel) &&
              (anthropicInputTokens > 0 || anthropicOutputTokens > 0)
            ) {
              // Adjust for racing - all models consumed input tokens
              const adjustedInputTokens = anthropicInputTokens * modelsRaced;
              const usageChunk = {
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                }],
                usage: {
                  prompt_tokens: adjustedInputTokens,
                  completion_tokens: anthropicOutputTokens,
                  total_tokens: adjustedInputTokens + anthropicOutputTokens,
                  cache_creation_input_tokens: anthropicCacheCreationTokens,
                  cache_read_input_tokens: anthropicCacheReadTokens,
                },
                requested_model: model,
                actual_model: winningModel,
                pool_name: poolName,
                pool_size: poolSize,
                racing_ttft_ms: ttftMs,
                models_raced: modelsRaced,
                timings,
                ...(claudeTokenError && { claude_token_error: claudeTokenError }),
              };
              const payload = `data: ${JSON.stringify(usageChunk)}\n\n`;
              controller.enqueue(encoder.encode(payload));
              slog(
                'info',
                `Anthropic usage adjusted: ${anthropicInputTokens} input × ${modelsRaced} models = ${adjustedInputTokens} total input tokens`,
              );
            }
            const donePayload = 'data: [DONE]\n\n';
            controller.enqueue(encoder.encode(donePayload));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          lines = processBuffer();

          for (const line of lines) {
            processLine(line);
          }
        }
      } catch (error) {
        slog('error', 'Streaming race winner error:', { data: error });
        controller.error(error);
      }
    },
  });
}
