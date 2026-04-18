/**
 * SSE streaming for completions.
 *
 * `handleStreaming` is the single entry point for every streaming completion:
 * Cerebras (rose-hyper), Anthropic (direct or via user Claude OAuth), and
 * OpenRouter. It handles stall detection with a mid-stream fallback, prompt
 * caching, native tool-mode JSON reconstruction, and uniform emission of
 * RoseCompletionChunk SSE events with usage/pool metadata.
 *
 * `transformSchemaForCerebras` is exported so racing and the handler can
 * pre-transform schemas before calling Cerebras.
 */

// deno-lint-ignore-file no-explicit-any

import {
  ANTHROPIC_API_URL,
  ANTHROPIC_BETA_HEADER,
  CEREBRAS_API_URL,
  corsHeaders,
} from '../config.ts';
import type { RoseCompletionChunk } from '../types.ts';
import {
  escapeForJsonString,
  parseRetryAfterMs,
  slog,
  truncateForLogging,
  withTimeout,
} from '../utils.ts';
import {
  applyAnthropicToolConfig,
  isAnthropicModel,
  transformMessagesForAnthropic,
} from './anthropic.ts';
import { getAnthropicModelName } from './cost.ts';
import { getMessagesForModel } from './vision.ts';

/**
 * Transform a JSON schema to be Cerebras-compatible.
 * Cerebras requires: additionalProperties: false for all objects with required arrays.
 * See: https://inference-docs.cerebras.ai/capabilities/structured-outputs
 */
export function transformSchemaForCerebras(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const transformed = { ...schema };

  // If it's an object type with properties, add additionalProperties: false
  if (transformed.type === 'object' && transformed.properties) {
    transformed.additionalProperties = false;

    // Cerebras requires all properties to be in required array
    if (!transformed.required) {
      transformed.required = Object.keys(transformed.properties);
    }

    // Recursively transform nested properties
    for (const key of Object.keys(transformed.properties)) {
      transformed.properties[key] = transformSchemaForCerebras(transformed.properties[key]);
    }
  }

  // Handle $defs (definitions)
  if (transformed.$defs) {
    for (const key of Object.keys(transformed.$defs)) {
      transformed.$defs[key] = transformSchemaForCerebras(transformed.$defs[key]);
    }
  }

  // Handle array items
  if (transformed.type === 'array' && transformed.items) {
    transformed.items = transformSchemaForCerebras(transformed.items);
  }

  // Handle anyOf/oneOf/allOf
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (transformed[keyword] && Array.isArray(transformed[keyword])) {
      transformed[keyword] = transformed[keyword].map((item: any) =>
        transformSchemaForCerebras(item)
      );
    }
  }

  return transformed;
}

// Handle streaming response
export async function handleStreaming(
  actualModel: string,
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any, // Added: response_format for structured outputs
  reasoning: { max_tokens?: number } | undefined, // Added: reasoning config for OpenRouter
  openRouterKey: string,
  supabaseUrl: string,
  requestedModel: string,
  isCerebras: boolean,
  poolName: string, // Added: for debugging
  poolSize: number, // Added: for debugging
  claudeAuth?: { token: string }, // Optional: user's Claude OAuth token (uses Bearer auth + Claude Code headers)
  skipCache?: boolean, // Optional: skip cache_control breakpoints (for single-use calls like param populator)
  stallConfig?: {
    timeoutMs: number; // Max ms between content deltas before triggering fallback
    onFallback: () => Promise<{
      reader: any; // ReadableStreamDefaultReader<Uint8Array> — TS variance mismatch between DOM libs
      firstData: string;
      actualModel: string;
      poolName: string;
      poolSize: number;
    }>;
  },
  claudeTokenError?: string, // Set when this streaming call is a fallback from a failed claude_token attempt
): Promise<Response> {
  // Get model-specific messages (transforms screenshots for vision models)
  const modelMessages = getMessagesForModel(messages, actualModel);

  // Perform fetch BEFORE creating ReadableStream so errors (401, 500, etc.)
  // propagate to the caller and can trigger fallback (e.g. claude_token → racing).
  let fetchResponse: globalThis.Response;
  let nativeToolMode = false;

  if (isCerebras) {
    // Call Cerebras API directly for rose-hyper
    const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY');
    slog('info', `Streaming from Cerebras API with model: ${actualModel}`);

    // Build Cerebras streaming request - supports tools with gpt-oss-120b
    const cerebrasStreamBody: any = {
      model: actualModel,
      messages: modelMessages, // Use transformed messages
      temperature,
      max_tokens: maxTokens,
      stream: true,
    };

    // Add tools for streaming (gpt-oss-120b supports this)
    if (tools && tools.length > 0) {
      cerebrasStreamBody.tools = tools;
    }
    if (toolChoice) {
      cerebrasStreamBody.tool_choice = toolChoice;
    }

    // Add response_format with schema transformation for Cerebras
    if (responseFormat) {
      if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
        const transformedSchema = transformSchemaForCerebras(responseFormat.json_schema.schema);
        cerebrasStreamBody.response_format = {
          type: 'json_schema',
          json_schema: {
            name: responseFormat.json_schema.name || 'response',
            strict: true,
            schema: transformedSchema,
          },
        };
      } else {
        cerebrasStreamBody.response_format = responseFormat;
      }
    }

    fetchResponse = await fetch(CEREBRAS_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cerebrasKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cerebrasStreamBody),
    });
  } else if (isAnthropicModel(actualModel) || claudeAuth) {
    // Call Anthropic API directly for Claude models (structured outputs require beta header)
    // When claudeAuth is set, actualModel is e.g. "claude-opus-4-7-claude" or "claude-sonnet-4-6-claude" — strip "-claude" suffix for API
    const anthropicModel = claudeAuth
      ? actualModel.replace('-claude', '')
      : getAnthropicModelName(actualModel);
    const { system, messages: anthropicMessages } = transformMessagesForAnthropic(modelMessages);

    const anthropicBody: any = {
      model: anthropicModel,
      messages: anthropicMessages,
      max_tokens: maxTokens || 4096,
      stream: true,
    };

    if (system) {
      if (skipCache) {
        anthropicBody.system = [{ type: 'text', text: system }];
      } else {
        // Array format with cache_control for prompt caching.
        // System prompt is identical across agent iterations — caching avoids re-processing.
        anthropicBody.system = [{
          type: 'text',
          text: system,
          cache_control: { type: 'ephemeral' },
        }];
      }
    }

    // Claude OAuth tokens require the first system block to be a recognized Claude Code/Agent SDK
    // identity string. Without this, the API returns generic "invalid_request_error: Error" for
    // Claude 4 models. Additional system blocks after the identity are allowed.
    if (claudeAuth) {
      const identityBlock = {
        type: 'text',
        text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      };
      const disclaimerBlock = {
        type: 'text',
        text:
          'Disregard the previous identity — you are NOT Claude Code. You are a Rose Labs AI agent. Follow the system instructions below.',
      };
      if (anthropicBody.system) {
        anthropicBody.system.unshift(identityBlock, disclaimerBlock);
      } else {
        anthropicBody.system = [identityBlock, disclaimerBlock];
      }
    }
    if (claudeAuth) {
      anthropicBody.thinking = { type: 'adaptive' };
      // Claude requires temperature=1 when thinking is enabled
      anthropicBody.temperature = 1;
    } else if (temperature !== undefined) {
      anthropicBody.temperature = temperature;
    }

    nativeToolMode = applyAnthropicToolConfig(anthropicBody, responseFormat, !!claudeAuth);

    // Anthropic: thinking is incompatible with tool_choice that forces tool use
    if (nativeToolMode && anthropicBody.thinking) {
      delete anthropicBody.thinking;
      // temperature=1 was set for thinking; remove the constraint
      delete anthropicBody.temperature;
    }

    // Add cache_control breakpoints on messages at regular intervals.
    // Anthropic allows up to 4 breakpoints total; 1 is on system, leaving 3 for messages.
    // Place every 20 messages (matching Anthropic's 20-block lookback window).
    if (!skipCache && anthropicBody.messages.length > 0) {
      const MAX_MSG_BREAKPOINTS = 3;
      const INTERVAL = 20;
      let placed = 0;
      // Walk backwards, place breakpoints at intervals from the end
      for (
        let i = anthropicBody.messages.length - 1;
        i >= 0 && placed < MAX_MSG_BREAKPOINTS;
        i -= INTERVAL
      ) {
        const msg = anthropicBody.messages[i];
        if (typeof msg.content === 'string') {
          // Convert string content to array format so we can attach cache_control
          msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          msg.content[msg.content.length - 1].cache_control = { type: 'ephemeral' };
        }
        placed++;
      }
      if (placed > 0) {
        slog(
          'info',
          `Placed ${placed} message cache breakpoints across ${anthropicBody.messages.length} messages`,
        );
      }
    }

    slog(
      'info',
      `Streaming from Anthropic API with model: ${anthropicModel}${
        claudeAuth ? ' (claude token)' : ''
      }${nativeToolMode ? ` (native tools: ${anthropicBody.tools.length})` : ''}${
        skipCache ? ' (skip_cache)' : ''
      }`,
    );

    // Use Claude OAuth token (user's subscription) or Rose's API key
    const anthropicHeaders: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    if (claudeAuth) {
      anthropicHeaders['Authorization'] = `Bearer ${claudeAuth.token}`;
      anthropicHeaders['anthropic-beta'] =
        'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24';
      anthropicHeaders['x-app'] = 'cli';
      anthropicHeaders['User-Agent'] = 'claude-cli/2.1.81 (external, sdk-ts, agent-sdk/0.2.75)';
    } else {
      const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
      if (!anthropicKey) {
        throw new Error(`ANTHROPIC_API_KEY required for ${actualModel}`);
      }
      anthropicHeaders['x-api-key'] = anthropicKey;
      anthropicHeaders['anthropic-beta'] = ANTHROPIC_BETA_HEADER;
    }

    slog('info', `[Anthropic Stream] Request to ${anthropicModel}:`, {
      data: JSON.stringify(truncateForLogging(anthropicBody), null, 2),
    });

    const anthropicFetchBody = JSON.stringify(anthropicBody);
    fetchResponse = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: anthropicHeaders,
      body: anthropicFetchBody,
    });

    // Retry on transient errors (429, 5xx) before starting the stream reader
    if (!fetchResponse.ok && (fetchResponse.status === 429 || fetchResponse.status >= 500)) {
      const delayMs = fetchResponse.status === 429
        ? Math.min(
          Math.max(parseRetryAfterMs(fetchResponse.headers.get('retry-after')), 1000),
          5000,
        )
        : 2000;
      slog('warn', `[Anthropic Stream] ${fetchResponse.status}, retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      fetchResponse = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: anthropicHeaders,
        body: anthropicFetchBody,
      });
    }
  } else {
    // Call OpenRouter API for other Rose models
    const openRouterBody: any = {
      model: actualModel,
      messages: modelMessages, // Use transformed messages
      temperature,
      max_tokens: maxTokens,
      seed,
      tools,
      tool_choice: toolChoice,
      stream: true,
    };

    // Add response_format for structured outputs
    if (responseFormat) {
      openRouterBody.response_format = responseFormat;
    }

    // Add reasoning config for reasoning models (Gemini, Anthropic, etc.)
    if (reasoning) {
      openRouterBody.reasoning = reasoning;
      slog('info', `Streaming with reasoning config:`, { data: reasoning });
    }

    slog('info', `[OpenRouter Stream] Request to ${actualModel}:`, {
      data: JSON.stringify(truncateForLogging(openRouterBody), null, 2),
    });

    fetchResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': supabaseUrl,
        'X-Title': 'Rose Benchmark Suite',
      },
      body: JSON.stringify(openRouterBody),
    });
  }

  if (!fetchResponse.ok) {
    const provider = isCerebras
      ? 'Cerebras'
      : (isAnthropicModel(actualModel) || claudeAuth)
      ? 'Anthropic'
      : 'OpenRouter';
    const errorText = await fetchResponse.text();
    slog('error', `${provider} streaming error:`, { data: [fetchResponse.status, errorText] });
    throw new Error(`${provider} API error: ${fetchResponse.status} - ${errorText.slice(0, 200)}`);
  }

  const reader = fetchResponse.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller): Promise<void> {
      try {
        const decoder = new TextDecoder();
        let buffer = '';

        // Stall detection: reassignable reader/model so we can swap to racing on stall
        let currentReader = reader;
        let currentModel = actualModel;
        let currentPoolName = poolName;
        let currentPoolSize = poolSize;
        let currentStallConfig = stallConfig;
        let hasReceivedContent = false;
        let lastContentTime = Date.now();
        let currentClaudeTokenError = claudeTokenError; // Mutable: set to 'stall' on stall fallback

        // Anthropic usage tracking - capture from message_start and message_delta
        let anthropicInputTokens = 0;
        let anthropicOutputTokens = 0;
        let anthropicCacheCreationTokens = 0;
        let anthropicCacheReadTokens = 0;

        // Native tool mode: reconstruct streaming JSON matching structured output format.
        // With tool_choice=auto, model produces text + tool_use blocks naturally.
        // Only active for execute phase (>8 tools). Plan phase uses structured output.
        // We wrap text in {"response": "...", "tool_calls": [...]} and inject tool names into partial_json.
        let ntState: 'initial' | 'in_response' | 'in_tool_calls' = 'initial';
        let ntCurrentBlock: 'text' | 'tool_use' | null = null;
        let ntCurrentToolName = '';
        let ntToolInputStarted = false;
        let ntToolCount = 0;
        let _stdCurrentBlock: 'text' | 'thinking' | null = null; // Standard mode: track block type for thinking support

        const emitDelta = (content: string) => {
          if (!content) return;
          const chunk: RoseCompletionChunk = {
            choices: [{ index: 0, delta: { content } }],
            requested_model: requestedModel,
            actual_model: currentModel,
            pool_name: currentPoolName,
            pool_size: currentPoolSize,
            ...(currentClaudeTokenError && { claude_token_error: currentClaudeTokenError }),
          };
          const payload = `data: ${JSON.stringify(chunk)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        };

        while (true) {
          // Stall detection: timeout reader.read() based on time since last content
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            if (currentStallConfig) {
              const elapsed = Date.now() - lastContentTime;
              const remaining = Math.max(currentStallConfig.timeoutMs - elapsed, 0);
              // deno-lint-ignore no-await-in-loop -- SSE stream reads are sequential by design
              const result = await withTimeout(currentReader.read(), remaining, 'content deadline');
              done = result.done;
              value = result.value;
            } else {
              // deno-lint-ignore no-await-in-loop -- SSE stream reads are sequential by design
              const result = await currentReader.read();
              done = result.done;
              value = result.value;
            }
          } catch (_timeoutError) {
            if (!hasReceivedContent && currentStallConfig?.onFallback) {
              // Never got content - seamlessly switch to racing
              slog('warn', '[Stall] No content from Claude in 60s, switching to racing');
              currentReader.cancel();
              if (claudeAuth) currentClaudeTokenError = 'stall'; // Signal transient failure to agent
              try {
                // deno-lint-ignore no-await-in-loop -- fallback switch is a one-shot sequential event
                const fallback = await currentStallConfig.onFallback();
                currentReader = fallback.reader;
                currentModel = fallback.actualModel;
                currentPoolName = fallback.poolName;
                currentPoolSize = fallback.poolSize;
                if (fallback.firstData) buffer += fallback.firstData;
                currentStallConfig = undefined; // disable timeout for racing reader
                lastContentTime = Date.now();
                continue;
              } catch (fallbackError) {
                slog('error', '[Stall] Fallback racing also failed, closing stream:', {
                  data: fallbackError,
                });
                controller.enqueue(
                  encoder.encode(
                    `data: ${
                      JSON.stringify({
                        error: { message: 'All model providers failed', type: 'server_error' },
                      })
                    }\n\n`,
                  ),
                );
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
                break;
              }
            }
            // Had content but stalled - close gracefully
            slog('warn', '[Stall] Claude stalled mid-content after 20s, closing');
            currentReader.cancel();
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }

          if (done) {
            // In native tool mode, close the JSON envelope
            if (nativeToolMode && isAnthropicModel(currentModel)) {
              if (ntState === 'initial') {
                emitDelta('{"response": "", "tool_calls": []}');
              } else if (ntState === 'in_response') {
                emitDelta('", "tool_calls": []}');
              } else if (ntState === 'in_tool_calls') {
                emitDelta(']}');
              }
              slog(
                'info',
                `Native tool mode complete: ${ntToolCount} tool(s), final state: ${ntState}`,
              );
            }

            // For Anthropic models, emit final usage chunk before [DONE]
            if (
              isAnthropicModel(currentModel) &&
              (anthropicInputTokens > 0 || anthropicOutputTokens > 0)
            ) {
              const usageChunk: RoseCompletionChunk = {
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                }],
                usage: {
                  prompt_tokens: anthropicInputTokens,
                  completion_tokens: anthropicOutputTokens,
                  total_tokens: anthropicInputTokens + anthropicOutputTokens,
                  cache_creation_input_tokens: anthropicCacheCreationTokens,
                  cache_read_input_tokens: anthropicCacheReadTokens,
                },
                requested_model: requestedModel,
                actual_model: currentModel,
                pool_name: currentPoolName,
                pool_size: currentPoolSize,
                ...(currentClaudeTokenError && { claude_token_error: currentClaudeTokenError }),
              };
              const payload = `data: ${JSON.stringify(usageChunk)}\n\n`;
              controller.enqueue(encoder.encode(payload));
              const cacheHitPct = anthropicInputTokens > 0
                ? Math.round(
                  anthropicCacheReadTokens /
                    (anthropicInputTokens + anthropicCacheCreationTokens +
                      anthropicCacheReadTokens) *
                    100,
                )
                : 0;
              slog(
                'info',
                `Anthropic usage emitted: input=${anthropicInputTokens}, output=${anthropicOutputTokens}, cache_read=${anthropicCacheReadTokens}, cache_write=${anthropicCacheCreationTokens}, cache_hit=${cacheHitPct}%`,
              );
            }
            const donePayload = 'data: [DONE]\n\n';
            controller.enqueue(encoder.encode(donePayload));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed = JSON.parse(data);

                // Transform Anthropic streaming events to OpenAI format
                if (isAnthropicModel(currentModel)) {
                  // Capture input tokens and cache metrics from message_start
                  if (parsed.type === 'message_start' && parsed.message?.usage) {
                    const msgUsage = parsed.message.usage;
                    anthropicInputTokens = msgUsage.input_tokens || 0;
                    anthropicCacheCreationTokens = msgUsage.cache_creation_input_tokens || 0;
                    anthropicCacheReadTokens = msgUsage.cache_read_input_tokens || 0;
                    slog(
                      'info',
                      `Anthropic input_tokens=${anthropicInputTokens}, cache_read=${anthropicCacheReadTokens}, cache_write=${anthropicCacheCreationTokens}`,
                    );
                    continue;
                  }

                  // Capture output tokens from message_delta
                  if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
                    anthropicOutputTokens = parsed.usage.output_tokens;
                    slog('info', `Anthropic output_tokens captured: ${anthropicOutputTokens}`);
                    continue;
                  }

                  if (nativeToolMode) {
                    // === NATIVE TOOL MODE ===
                    // With tool_choice=any (forced), model MUST produce tool_use blocks.
                    // Thinking is disabled to avoid incompatibility with forced tool use.
                    // Reconstruct: {"response": "<text>", "tool_calls": [{"tool": "<name>", ...}]}

                    if (parsed.type === 'content_block_start') {
                      if (parsed.content_block?.type === 'text') {
                        ntCurrentBlock = 'text';
                        if (ntState === 'initial') {
                          emitDelta('{"response": "');
                          ntState = 'in_response';
                        }
                      } else if (parsed.content_block?.type === 'tool_use') {
                        ntCurrentBlock = 'tool_use';
                        ntCurrentToolName = parsed.content_block.name || '';
                        ntToolInputStarted = false;
                        if (ntState === 'initial') {
                          emitDelta('{"response": "", "tool_calls": [');
                          ntState = 'in_tool_calls';
                        } else if (ntState === 'in_response') {
                          emitDelta('", "tool_calls": [');
                          ntState = 'in_tool_calls';
                        }
                        if (ntToolCount > 0) {
                          emitDelta(', ');
                        }
                        ntToolCount++;
                      }
                      continue;
                    }

                    if (parsed.type === 'content_block_delta') {
                      lastContentTime = Date.now();
                      hasReceivedContent = true;
                      if (ntCurrentBlock === 'text' && parsed.delta?.text) {
                        emitDelta(escapeForJsonString(parsed.delta.text));
                      } else if (
                        ntCurrentBlock === 'tool_use' && parsed.delta &&
                        'partial_json' in parsed.delta
                      ) {
                        const fragment: string = parsed.delta.partial_json ?? '';
                        if (!fragment) {
                          // Empty string delta — skip, wait for actual content
                          continue;
                        }
                        if (!ntToolInputStarted) {
                          ntToolInputStarted = true;
                          if (fragment === '{}') {
                            emitDelta(`{"tool": "${ntCurrentToolName}"}`);
                          } else if (fragment.startsWith('{')) {
                            emitDelta(`{"tool": "${ntCurrentToolName}", ` + fragment.slice(1));
                          } else {
                            emitDelta(`{"tool": "${ntCurrentToolName}", ` + fragment);
                          }
                        } else {
                          emitDelta(fragment);
                        }
                      }
                      continue;
                    }

                    if (parsed.type === 'content_block_stop') {
                      // If tool_use block ended without any non-empty partial_json, emit bare tool name
                      if (ntCurrentBlock === 'tool_use' && !ntToolInputStarted) {
                        emitDelta(`{"tool": "${ntCurrentToolName}"}`);
                      }
                      ntCurrentBlock = null;
                      continue;
                    }

                    continue;
                  }

                  // === STANDARD MODE: original streaming logic ===

                  // Track current block type for thinking support
                  if (parsed.type === 'content_block_start') {
                    if (parsed.content_block?.type === 'thinking') {
                      _stdCurrentBlock = 'thinking';
                    } else if (parsed.content_block?.type === 'text') {
                      _stdCurrentBlock = 'text';
                    }
                    continue;
                  }

                  if (parsed.type === 'content_block_stop') {
                    _stdCurrentBlock = null;
                    continue;
                  }

                  // Skip other non-content events
                  if (parsed.type !== 'content_block_delta') {
                    continue;
                  }

                  lastContentTime = Date.now();
                  hasReceivedContent = true;

                  // Forward thinking deltas as delta.reasoning (matches OpenRouter format that agents already consume)
                  if (parsed.delta?.thinking) {
                    const reasoningChunk: any = {
                      choices: [{ index: 0, delta: { reasoning: parsed.delta.thinking } }],
                      requested_model: requestedModel,
                      actual_model: currentModel,
                      pool_name: currentPoolName,
                      pool_size: currentPoolSize,
                    };
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(reasoningChunk)}\n\n`),
                    );
                    continue;
                  }

                  // Transform text/partial_json to OpenAI format (unchanged)
                  emitDelta(parsed.delta?.text || parsed.delta?.partial_json || '');
                } else {
                  // OpenRouter/Cerebras - pass through with metadata
                  // Skip chunks with empty/missing choices (OpenRouter debug/echo chunks)
                  if (!parsed.choices?.length) {
                    continue;
                  }
                  lastContentTime = Date.now();
                  hasReceivedContent = true;

                  // Translate OpenRouter cache fields to canonical Anthropic format
                  if (parsed.usage?.prompt_tokens_details) {
                    const details = parsed.usage.prompt_tokens_details;
                    const cachedTokens = details.cached_tokens || 0;
                    const cacheWriteTokens = details.cache_write_tokens || 0;
                    parsed.usage.cache_read_input_tokens = cachedTokens;
                    parsed.usage.cache_creation_input_tokens = cacheWriteTokens;
                    parsed.usage.prompt_tokens = Math.max(
                      0,
                      parsed.usage.prompt_tokens - cachedTokens - cacheWriteTokens,
                    );
                  }

                  parsed.requested_model = requestedModel;
                  parsed.actual_model = currentModel;
                  parsed.pool_name = currentPoolName;
                  parsed.pool_size = currentPoolSize;
                  if (currentClaudeTokenError) parsed.claude_token_error = currentClaudeTokenError;
                  const payload = `data: ${JSON.stringify(parsed)}\n\n`;
                  controller.enqueue(encoder.encode(payload));
                }
              } catch (e) {
                slog('error', 'Error parsing streaming data:', { data: e });
              }
            } else if (line.startsWith('event: ')) {
              // Anthropic uses separate event lines - skip them (data follows)
              continue;
            }
          }
        }
      } catch (error) {
        slog('error', 'Streaming error:', { data: error });
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
