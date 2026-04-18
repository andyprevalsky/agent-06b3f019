/**
 * Trio racing & waterfall streaming.
 *
 * - `selectRacingTrio` picks a trio from the pool using cached latencies,
 *   applying hard latency caps + per-trio delay caps, and computes per-model
 *   start delays so all three finish around the same time.
 * - `raceModels` fires the trio in parallel, waits for the first CONTENTFUL
 *   token (not just headers), aborts the losers immediately to save spend,
 *   and updates the latency cache.
 * - `raceBrowserUseModels` is the browser-use variant: it races to full
 *   COMPLETION instead of first token.
 * - `waterfallStream` tries models sequentially, falling through on failure.
 *   Used when we want to avoid burning tokens on parallel attempts.
 */

// deno-lint-ignore-file no-explicit-any

import {
  ANTHROPIC_API_URL,
  ANTHROPIC_BETA_HEADER,
  corsHeaders,
  MAX_DELAY_CAP_MS,
  MAX_LATENCY_CAP_MS,
  TRIO_SIZE,
  WATERFALL_TIMEOUT_MS,
} from '../config.ts';
import { incrementLoserLatency, saveConversationModel, updateLatencyCache } from '../repo.ts';
import type { RacingConfig, RacingModel, SupabaseClient, UnifiedAction } from '../types.ts';
import { slog, truncateForLogging, withTimeout } from '../utils.ts';
import {
  isAnthropicModel,
  transformMessagesForAnthropic,
  transformSchemaForAnthropic,
} from './anthropic.ts';
import { getAnthropicModelName } from './cost.ts';
import { handleStreaming } from './streaming.ts';
import { getMessagesForModel } from './vision.ts';

/**
 * Waterfall streaming: try models sequentially until one succeeds.
 * Unlike trio racing (parallel), this sends input tokens to only ONE model per request.
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

/**
 * Select a random trio from the pool, calculate delays based on cached latencies.
 *
 * Strategy:
 * 1. First, exclude models with latency > hard cap
 * 2. Group remaining models by latency bands (within delay cap of each other)
 * 3. Prefer the fastest band, randomly select trio from that band
 * 4. Add delays to fast models so they finish at same time as the slowest in the trio
 */
export function selectRacingTrio(
  pool: string[],
  cachedLatencies: Map<string, number>,
  config?: Partial<RacingConfig>,
): RacingModel[] {
  const maxLatencyCapMs = config?.maxLatencyCapMs ?? MAX_LATENCY_CAP_MS;
  const maxDelayCapMs = config?.maxDelayCapMs ?? MAX_DELAY_CAP_MS;
  const defaultLatencyMs = config?.defaultLatencyMs ?? 500;
  const trioSize = config?.trioSize ?? TRIO_SIZE;

  // Get all models with their latencies
  const modelsWithLatency = pool.map((model) => ({
    model,
    latencyMs: cachedLatencies.get(model) || defaultLatencyMs,
  }));

  // Filter out models exceeding hard latency cap
  const underHardCap = modelsWithLatency.filter((m) => {
    if (m.latencyMs > maxLatencyCapMs) {
      slog(
        'warn',
        `Excluding ${m.model} - latency ${m.latencyMs}ms exceeds ${maxLatencyCapMs}ms cap`,
      );
      return false;
    }
    return true;
  });

  if (underHardCap.length === 0) {
    slog(
      'warn',
      `No eligible models after ${maxLatencyCapMs}ms cap, using full pool with fastest models`,
    );
    const sorted = modelsWithLatency.sort((a, b) => a.latencyMs - b.latencyMs);
    return sorted.slice(0, trioSize).map((m) => ({ ...m, delayMs: 0 }));
  }

  // Sort by latency (fastest first)
  underHardCap.sort((a, b) => a.latencyMs - b.latencyMs);

  // Find models within delay cap of the fastest model
  const fastestLatency = underHardCap[0].latencyMs;
  const withinDelayCap = underHardCap.filter((m) =>
    (m.latencyMs - fastestLatency) <= maxDelayCapMs
  );

  // Log what we excluded due to delay cap
  const excludedByDelay = underHardCap.filter((m) =>
    (m.latencyMs - fastestLatency) > maxDelayCapMs
  );
  for (const m of excludedByDelay) {
    slog(
      'warn',
      `Excluding ${m.model} - latency ${m.latencyMs}ms is ${
        m.latencyMs - fastestLatency
      }ms slower than fastest (${fastestLatency}ms), exceeds ${maxDelayCapMs}ms delay cap`,
    );
  }

  // ALWAYS include the fastest model, then randomly select the rest
  const fastestModel = withinDelayCap[0]; // Already sorted, index 0 is fastest
  const otherModels = withinDelayCap.slice(1);

  // Shuffle the rest and pick trioSize - 1
  const shuffledOthers = [...otherModels].sort(() => Math.random() - 0.5);
  const randomOthers = shuffledOthers.slice(0, Math.min(trioSize - 1, shuffledOthers.length));

  // Combine: fastest + random others
  const selectedModels = [fastestModel, ...randomOthers];
  slog(
    'info',
    `Trio: fastest=${fastestModel.model}, others=[${randomOthers.map((m) => m.model).join(', ')}]`,
  );

  // Find the slowest model in the selected trio
  const slowestInTrio = Math.max(...selectedModels.map((m) => m.latencyMs));

  // Calculate delays: fast models wait so all finish ~simultaneously
  const racingModels: RacingModel[] = selectedModels.map((m) => ({
    model: m.model,
    latencyMs: m.latencyMs,
    delayMs: slowestInTrio - m.latencyMs,
  }));

  slog('info', `Racing trio (target finish ~${slowestInTrio}ms):`, {
    data: racingModels.map((m) =>
      `${m.model} (${m.latencyMs}ms + ${m.delayMs}ms delay = ${m.latencyMs + m.delayMs}ms)`
    ),
  });

  return racingModels;
}

/**
 * Race multiple models and return the first response.
 * Uses AbortController to cancel losing requests and save API costs.
 */
export async function raceModels(
  racingModels: RacingModel[],
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any,
  reasoning: any,
  openRouterKey: string,
  supabaseUrl: string,
  supabase: SupabaseClient,
  pool: string,
  timings: { [key: string]: number }, // Track timing breakdown
): Promise<
  {
    model: string;
    reader: ReadableStreamDefaultReader<Uint8Array>;
    ttftMs: number;
    firstData: string;
  }
> {
  slog('info', `Starting race with ${racingModels.length} models:`, {
    data: racingModels.map((m) => `${m.model} (delay: ${m.delayMs}ms)`),
  });
  const raceInternalStart = Date.now();
  timings.race_internal_start = 0;

  // Create AbortController for each model to cancel losers
  const controllers = racingModels.map(() => new AbortController());
  let winnerIndex = -1;

  // Create race promises that resolve on success and never reject (errors become null)
  const racePromises = racingModels.map(
    async (
      { model, delayMs },
      index,
    ): Promise<
      {
        model: string;
        reader: ReadableStreamDefaultReader<Uint8Array>;
        ttftMs: number;
        index: number;
        firstData: string;
      } | null
    > => {
      const modelKey = model.split('/').pop() || model;
      try {
        // Apply delay to equalize finish times
        if (delayMs > 0) {
          slog('info', `${model} waiting ${delayMs}ms before firing...`);
          timings[`${modelKey}_delay_start`] = Date.now() - raceInternalStart;
          await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(resolve, delayMs);
            // If aborted during delay, reject immediately
            controllers[index].signal.addEventListener('abort', () => {
              clearTimeout(timeoutId);
              reject(new DOMException('Aborted during delay', 'AbortError'));
            });
          });
          timings[`${modelKey}_delay_end`] = Date.now() - raceInternalStart;
        }

        // Check if already aborted before firing
        if (controllers[index].signal.aborted) {
          slog('info', `${model} aborted before firing`);
          return null;
        }

        const startTime = Date.now();
        timings[`${modelKey}_fire`] = Date.now() - raceInternalStart;
        slog('info', `${model} firing request at t=${timings[`${modelKey}_fire`]}ms...`);

        // Get model-specific messages (transforms screenshots for vision models)
        const modelMessages = getMessagesForModel(messages, model);

        let response: globalThis.Response;

        // Build fetch params (hoisted so 429 retry can re-use them)
        let fetchUrl: string;
        let fetchHeaders: Record<string, string>;
        let fetchBody: string;

        // Call Anthropic directly for Claude models (structured outputs require beta header)
        if (isAnthropicModel(model)) {
          const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
          if (!anthropicKey) {
            slog('error', `${model} requires ANTHROPIC_API_KEY`);
            return null;
          }

          const anthropicModel = getAnthropicModelName(model);
          const { system, messages: anthropicMessages } = transformMessagesForAnthropic(
            modelMessages,
          );

          const anthropicBody: any = {
            model: anthropicModel,
            messages: anthropicMessages,
            max_tokens: maxTokens || 4096,
            stream: true,
          };

          if (system) {
            // Array format with cache_control for prompt caching (stable across racing retries)
            anthropicBody.system = [{
              type: 'text',
              text: system,
              cache_control: { type: 'ephemeral' },
            }];
          }
          if (temperature !== undefined) {
            anthropicBody.temperature = temperature;
          }

          // Transform response_format to Anthropic's output_format
          if (responseFormat?.json_schema?.schema) {
            const transformedSchema = transformSchemaForAnthropic(
              responseFormat.json_schema.schema,
            );
            anthropicBody.output_format = {
              type: 'json_schema',
              schema: transformedSchema,
            };
          }

          slog('info', `Calling Anthropic directly for ${anthropicModel}`);
          slog('info', `[Anthropic Race] Request to ${anthropicModel}:`, {
            data: JSON.stringify(truncateForLogging(anthropicBody), null, 2),
          });
          fetchUrl = ANTHROPIC_API_URL;
          fetchHeaders = {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': ANTHROPIC_BETA_HEADER,
            'content-type': 'application/json',
          };
          fetchBody = JSON.stringify(anthropicBody);
        } else {
          // Call OpenRouter for other models
          const body: any = {
            model,
            messages: modelMessages, // Use model-specific messages (vision transform)
            temperature,
            max_tokens: maxTokens,
            seed,
            tools,
            tool_choice: toolChoice,
            stream: true,
          };

          if (responseFormat) {
            body.response_format = responseFormat;
          }
          if (reasoning) {
            body.reasoning = reasoning;
          }

          slog('info', `[OpenRouter Race] Request to ${model}:`, {
            data: JSON.stringify(truncateForLogging(body), null, 2),
          });
          fetchUrl = 'https://openrouter.ai/api/v1/chat/completions';
          fetchHeaders = {
            'Authorization': `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose AI - Trio Racing',
          };
          fetchBody = JSON.stringify(body);
        }

        response = await fetch(fetchUrl, {
          method: 'POST',
          headers: fetchHeaders,
          body: fetchBody,
          signal: controllers[index].signal,
        });

        const headersTime = Date.now() - startTime;
        timings[`${modelKey}_headers`] = Date.now() - raceInternalStart;
        slog(
          'info',
          `${model} headers in ${headersTime}ms at t=${
            timings[`${modelKey}_headers`]
          }ms (status: ${response.status})`,
        );

        if (!response.ok) {
          const errorText = await response.text();
          slog('error', `${model} failed: ${response.status} - ${errorText}`);

          // Retry once on 429 (rate limit) — common under batch concurrency
          if (response.status === 429 && !controllers[index].signal.aborted) {
            const retryAfterRaw = response.headers.get('retry-after');
            const retryAfterSeconds = (() => {
              if (!retryAfterRaw) return 2;
              const deltaSeconds = Number(retryAfterRaw);
              if (Number.isFinite(deltaSeconds)) return deltaSeconds;
              const retryAtMs = Date.parse(retryAfterRaw);
              if (Number.isFinite(retryAtMs)) {
                return Math.ceil((retryAtMs - Date.now()) / 1000);
              }
              return 2;
            })();
            const delayS = Math.min(Math.max(Math.ceil(retryAfterSeconds), 1), 5);
            slog('info', `${model} 429 — retrying in ${delayS}s`);
            await new Promise((r) => setTimeout(r, delayS * 1000));
            if (controllers[index].signal.aborted) {
              slog('info', `${model} aborted during 429 retry delay`);
              return null;
            }
            response = await fetch(fetchUrl, {
              method: 'POST',
              headers: fetchHeaders,
              body: fetchBody,
              signal: controllers[index].signal,
            });
            slog('info', `${model} 429 retry → status ${response.status}`);
            if (!response.ok) {
              const retryErrorText = await response.text();
              slog('error', `${model} 429 retry failed: ${response.status} - ${retryErrorText}`);
              return null;
            }
          } else {
            return null;
          }
        }

        // CRITICAL: Wait for FIRST ACTUAL DATA, not just headers!
        // This prevents slow models from winning just because their headers arrive first
        const reader = response.body?.getReader();
        if (!reader) {
          slog('error', `${model} no response body`);
          return null;
        }

        const decoder = new TextDecoder();
        let buffer = ''; // For parsing - holds incomplete line
        let allData = ''; // Accumulate ALL data for firstData (needed for Anthropic message_start)

        // Read until we get a real data line (not just ": OPENROUTER PROCESSING")
        while (true) {
          // Check if aborted while waiting for content
          if (controllers[index].signal.aborted) {
            slog('info', `${model} aborted while waiting for content`);
            reader.cancel();
            return null;
          }

          // deno-lint-ignore no-await-in-loop -- sequential SSE read
          const { done, value } = await reader.read();
          if (done) {
            slog('error', `${model} stream ended before data`);
            return null;
          }

          const chunk = decoder.decode(value, { stream: true });
          allData += chunk; // Accumulate everything for firstData
          buffer += chunk;
          const lines = buffer.split('\n');

          for (const line of lines) {
            // Look for actual data line with CONTENTFUL tokens (not just heartbeats)
            if (line.startsWith('data:') && !line.includes('[DONE]')) {
              try {
                const jsonStr = line.slice(5).trim(); // Remove "data:" prefix
                if (jsonStr) {
                  const parsed = JSON.parse(jsonStr);

                  // Handle both OpenRouter/OpenAI format and Anthropic format
                  let hasContent = false;
                  if (parsed.choices?.[0]?.delta) {
                    // OpenRouter/OpenAI format
                    const delta = parsed.choices[0].delta;
                    hasContent = delta.content || delta.reasoning;
                  } else if (
                    parsed.type === 'content_block_delta' &&
                    (parsed.delta?.text || parsed.delta?.partial_json)
                  ) {
                    // Anthropic streaming format (text or structured output)
                    hasContent = true;
                  }

                  if (hasContent) {
                    const ttftMs = Date.now() - startTime;
                    timings[`${modelKey}_ttft`] = ttftMs;
                    timings[`${modelKey}_first_data`] = Date.now() - raceInternalStart;
                    slog(
                      'info',
                      `${model} FIRST CONTENTFUL TOKEN in ${ttftMs}ms at t=${
                        timings[`${modelKey}_first_data`]
                      }ms`,
                    );

                    // IMMEDIATELY abort all other racing models to save API costs
                    // Don't wait for promise resolution - kill them NOW
                    controllers.forEach((controller, i) => {
                      if (i !== index) {
                        slog('info', `Immediately aborting loser: ${racingModels[i].model}`);
                        controller.abort();
                      }
                    });

                    // Return the reader (not response) since we've already started reading
                    // Return allData (includes all events like message_start) not just buffer
                    return { model, reader, ttftMs, index, firstData: allData };
                  }
                }
              } catch (_e) {
                // Skip unparseable lines
              }
            }
          }

          // Keep incomplete line in buffer for next iteration
          buffer = lines[lines.length - 1] || '';
        }
      } catch (error) {
        // Don't log abort errors - they're expected for losers
        if (error instanceof DOMException && error.name === 'AbortError') {
          slog('info', `${model} aborted (race lost)`);
          return null;
        }
        slog('error', `${model} error:`, { data: error });
        return null;
      }
    },
  );

  // Use Promise.race with a filter for successful responses
  // We need custom logic since Promise.race doesn't skip null values
  const winner = await new Promise<
    {
      model: string;
      reader: ReadableStreamDefaultReader<Uint8Array>;
      ttftMs: number;
      firstData: string;
    }
  >((resolve, reject) => {
    let resolved = false;
    let completed = 0;

    racePromises.forEach(async (promise) => {
      try {
        const result = await promise;
        completed++;

        if (result && !resolved) {
          resolved = true;
          winnerIndex = result.index;
          slog('info', `Winner: ${result.model} (TTFT: ${result.ttftMs}ms)`);

          // Losers already aborted inline when winner found contentful token
          // Just update loser latencies (fire-and-forget)
          controllers.forEach((_controller, i) => {
            if (i !== winnerIndex) {
              // Increment loser's latency by 10ms (reduces sandbagging, gives them better chance next race)
              incrementLoserLatency(supabase, racingModels[i].model, pool)
                .catch((e) => slog('error', `Failed to increment loser latency:`, { data: e }));
            }
          });

          // Update cache for winning model with actual race TTFT (keeps cache fresh)
          updateLatencyCache(supabase, result.model, pool, result.ttftMs)
            .then(() =>
              slog('info', `Cache updated for winner: ${result.model} = ${result.ttftMs}ms`)
            )
            .catch((e) => slog('error', `Failed to update winner cache:`, { data: e }));

          resolve({
            model: result.model,
            reader: result.reader,
            ttftMs: result.ttftMs,
            firstData: result.firstData,
          });
        } else if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      } catch (_e) {
        completed++;
        if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      }
    });
  });

  return winner;
}

/**
 * Races browser-use providers to COMPLETION (not first token).
 * Winner = first provider to return a complete response.
 */
export async function raceBrowserUseModels(
  racingModels: RacingModel[],
  callProviderFn: (model: string, poolIndex: number, signal: AbortSignal) => Promise<{
    action: UnifiedAction;
    ttftMs: number;
    actualModel: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>,
  browserPool: string[],
  supabase: SupabaseClient,
  pool: string,
  _requestId: string,
  timings: Record<string, number>,
): Promise<{
  action: UnifiedAction;
  ttftMs: number;
  actualModel: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  modelsRaced: number;
  racingModels: RacingModel[];
}> {
  slog('info', `Starting completion race with ${racingModels.length} models:`, {
    data: racingModels.map((m) => `${m.model} (delay: ${m.delayMs}ms)`),
  });
  const raceInternalStart = Date.now();
  timings.race_internal_start = 0;

  // Create AbortController for each model to cancel losers
  const controllers = racingModels.map(() => new AbortController());
  let winnerIndex = -1;

  // Create race promises that resolve on success and never reject (errors become null)
  const racePromises = racingModels.map(async ({ model, delayMs }, index): Promise<
    {
      action: UnifiedAction;
      ttftMs: number;
      actualModel: string;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      index: number;
      completionMs: number;
    } | null
  > => {
    const modelKey = model.split('/').pop() || model;
    try {
      // Apply delay to equalize finish times
      if (delayMs > 0) {
        slog('info', `${model} waiting ${delayMs}ms before firing...`);
        timings[`${modelKey}_delay_start`] = Date.now() - raceInternalStart;
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delayMs);
          // If aborted during delay, reject immediately
          controllers[index].signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            reject(new DOMException('Aborted during delay', 'AbortError'));
          });
        });
        timings[`${modelKey}_delay_end`] = Date.now() - raceInternalStart;
      }

      // Check if already aborted before firing
      if (controllers[index].signal.aborted) {
        slog('info', `${model} aborted before firing`);
        return null;
      }

      const startTime = Date.now();
      timings[`${modelKey}_fire`] = Date.now() - raceInternalStart;
      slog('info', `${model} firing request at t=${timings[`${modelKey}_fire`]}ms...`);

      const poolIndex = browserPool.indexOf(model);
      const result = await callProviderFn(model, poolIndex, controllers[index].signal);

      const completionMs = Date.now() - startTime;
      timings[`${modelKey}_complete`] = Date.now() - raceInternalStart;
      timings[`${modelKey}_latency`] = completionMs;
      slog(
        'info',
        `${model} COMPLETED in ${completionMs}ms at t=${timings[`${modelKey}_complete`]}ms`,
      );

      // IMMEDIATELY abort all other racing models to save API costs
      // Don't wait for promise resolution - kill them NOW
      controllers.forEach((controller, i) => {
        if (i !== index) {
          slog('info', `Immediately aborting loser: ${racingModels[i].model}`);
          controller.abort();
        }
      });

      return { ...result, index, completionMs };
    } catch (error) {
      // Don't log abort errors - they're expected for losers
      if (error instanceof DOMException && error.name === 'AbortError') {
        slog('info', `${model} aborted (race lost)`);
        return null;
      }
      slog('error', `${model} error:`, { data: error });
      return null;
    }
  });

  // Use Promise.race with a filter for successful responses
  // We need custom logic since Promise.race doesn't skip null values
  const winner = await new Promise<{
    action: UnifiedAction;
    ttftMs: number;
    actualModel: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    index: number;
    completionMs: number;
  }>((resolve, reject) => {
    let resolved = false;
    let completed = 0;

    racePromises.forEach(async (promise) => {
      try {
        const result = await promise;
        completed++;

        if (result && !resolved) {
          resolved = true;
          winnerIndex = result.index;
          slog('info', `Winner: ${result.actualModel} (${result.completionMs}ms)`);

          // Losers already aborted inline when winner completed
          // Just update loser latencies (fire-and-forget)
          controllers.forEach((_controller, i) => {
            if (i !== winnerIndex) {
              // Increment loser's latency by 10ms (reduces sandbagging, gives them better chance next race)
              incrementLoserLatency(supabase, racingModels[i].model, pool)
                .catch((e) => slog('error', `Failed to increment loser latency:`, { data: e }));
            }
          });

          // Update cache for winning model with actual completion time (keeps cache fresh)
          updateLatencyCache(supabase, result.actualModel, pool, result.completionMs)
            .then(() =>
              slog(
                'info',
                `Cache updated for winner: ${result.actualModel} = ${result.completionMs}ms`,
              )
            )
            .catch((e) => slog('error', `Failed to update winner cache:`, { data: e }));

          resolve(result);
        } else if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      } catch (_e) {
        completed++;
        if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      }
    });
  });

  return {
    action: winner.action,
    ttftMs: winner.completionMs,
    actualModel: winner.actualModel,
    usage: winner.usage,
    modelsRaced: racingModels.length,
    racingModels,
  };
}
