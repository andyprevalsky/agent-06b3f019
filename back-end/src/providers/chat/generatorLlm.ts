/**
 * Generator LLM - Second step in chat mode.
 * Generates the user-facing response with streaming support.
 * Uses the in-process Rose completions client.
 * Uses structured output with separate reasoning (thinking) and response (true message) fields.
 */

import { z } from 'zod';
import {
  createStreamingCompletion,
  markCacheable,
  type CompletionChunk,
  type CompletionOptions,
} from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { agentFastMode, cacheSet } from '../demoCacheStore';
import { goalHash } from '../demoCacheNormalizeCore';
import { contentKey } from '../demoCacheNormalizeKeys';
import { GENERATOR_SYSTEM_PROMPT } from './chatPrompts';
import { broadcastAssistantStream, generateStreamId } from './supabaseBroadcast';
import { createLogger } from '../logger';
import {
  buildMultimodalContentFromFile,
  isValidFilePointer,
  type MultimodalContentBlock,
} from './chatMultimodal';
import {
  accumulateChatLlmUsage,
  applyChunkUsage,
  emptyChatLlmUsage,
  type ChatLlmUsage,
} from './routerLlm';
import type { ChatProviderRoute } from './phaseModels';
import type { ChatCompletionParams } from './completionOptions';
import { withCurrentTimeContext } from '../currentTimeContext';
import { runAfterStreamCommit, type TransactionalStreamGate } from './earlyDirectGenerator';
import {
  createGeneratorAttentionLifecycle,
  type GeneratorAttentionLifecycle,
} from './generatorAttentionStream';
import { ensureVerbatimIncludes } from './ensureVerbatimIncludes';
import { extractPartialStringField } from './routerJsonStream';
import { isCloudAgentLifecycleTool } from './cloudAgentLifecycleTool';
import { userFacingTextDescription } from '../userFacingWritingPrompt';
import { createGeneratorCacheStream } from './generatorCacheStream';
import { runCacheWriteInBackground } from './backgroundCacheWrite';
import { ChatLlmTransientMissError, regenerateOnChatStructuredMiss } from './chatStructuredRetry';

export const GeneratorResponseSchema = z.object({
  reasoning: z.string(),
  response: z.string().min(1),
});

export function requireGeneratorParsedJson(fullJson: string): {
  reasoning: string;
  response: string;
} {
  if (!fullJson) {
    throw new ChatLlmTransientMissError('empty', 'Generator LLM returned no content');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fullJson);
  } catch (error) {
    throw new ChatLlmTransientMissError(
      'parse',
      `Failed to parse generator response as JSON: ${fullJson.substring(0, 200)}`,
      { cause: error }
    );
  }
  const result = GeneratorResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new ChatLlmTransientMissError(
      'parse',
      `Generator response failed schema: ${result.error.issues[0]?.message ?? 'invalid'}`
    );
  }
  return result.data;
}

const log = createLogger('GeneratorLLM');

interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  filePointer?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ============================================
// Generator Response
// ============================================
export interface GeneratorResponse {
  reasoning: string;
  response: string;
  streamId: string;
  toolCallId: string;
  usage: ChatLlmUsage;
}

// ============================================
// JSON Schema for structured output
// ============================================
export const GENERATOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Your internal reasoning and thought process for formulating the response',
    },
    response: {
      type: 'string',
      description: userFacingTextDescription('The exact chat message sent to the user.'),
    },
  },
  required: ['reasoning', 'response'],
  additionalProperties: false,
};

// ============================================
// Extract reasoning only. Final-answer response text streams through the keyed
// ATTENTION_STREAM lifecycle instead of the thinking bubble.
// ============================================
function extractStreamableReasoning(
  accumulatedReasoning: string,
  accumulatedJson: string
): string | null {
  const parts: string[] = [];

  // Add reasoning if present (from delta.reasoning for thinking models)
  if (accumulatedReasoning.trim()) {
    parts.push(accumulatedReasoning.trim());
  }

  // Try to extract the reasoning field from JSON (for non-thinking models)
  const jsonReasoning = extractPartialStringField(accumulatedJson, 'reasoning');
  if (jsonReasoning && jsonReasoning.trim()) {
    // Only add if different from accumulated reasoning
    if (!accumulatedReasoning.trim()) {
      parts.push(jsonReasoning.trim());
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ============================================
// Generator LLM Call with Streaming
// ============================================
export function buildGeneratorCompletionOptions(params: ChatCompletionParams): CompletionOptions {
  return {
    model: params.model,
    messages: withCurrentTimeContext(params.messages),
    temperature: 0.7,
    // Bound Cerebras's upfront token reservation while leaving room for a
    // substantive answer and the structured response's reasoning field.
    ...(params.providerRoute === 'direct-cerebras' ? { max_tokens: 4_096 } : {}),
    // Keep synchronous chat fallbacks latency-bounded. Cerebras disables
    // reasoning at its provider boundary; OpenRouter models such as Gemini
    // require reasoning, so request their smallest supported budget instead
    // of accepting the provider's slower default.
    effort: 'minimal',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'generator_response',
        strict: true,
        schema: GENERATOR_JSON_SCHEMA,
      },
    },
    dump_context: { agent_id: params.agentId, call_site: 'chat_generator' },
    provider_fast_mode: params.providerFastMode,
    ...(params.providerRoute !== undefined ? { provider_route: params.providerRoute } : {}),
    abort_signal: params.abortSignal,
  };
}

type GeneratorLlmParams = {
  agentId: string;
  messages: ChatMessage[];
  userProfileContext?: string;
  model: string;
  providerRoute?: ChatProviderRoute;
  abortSignal?: AbortSignal;
  streamGate?: TransactionalStreamGate;
};

export async function callGeneratorLlm(params: GeneratorLlmParams): Promise<GeneratorResponse> {
  let attention: GeneratorAttentionLifecycle | undefined;
  try {
    return await callGeneratorLlmCore(params, (current) => {
      attention = current;
    });
  } catch (error) {
    await attention?.cancel();
    throw error;
  }
}

async function callGeneratorLlmCore(
  params: GeneratorLlmParams,
  setAttention: (attention: GeneratorAttentionLifecycle) => void
): Promise<GeneratorResponse> {
  const streamId = generateStreamId();

  // Convert messages to OpenAI format (with multimodal support).
  // The system prompt is wrapped in `markCacheable` so the static prefix is
  // explicitly tagged for Anthropic prompt caching at the call-site level.
  // See back-end/src/providers/rose/cache.ts for the helper contract.
  const openaiMessages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | MultimodalContentBlock[];
  }> = [markCacheable(GENERATOR_SYSTEM_PROMPT, params.userProfileContext)];

  for (const msg of params.messages) {
    if (msg.role === 'TOOL') {
      // Skip UI-only lifecycle tools and IN_PROGRESS messages.
      // This matches worker behavior in agents/helpers/llm.py lines 236-238
      if (isCloudAgentLifecycleTool(msg.metadata) || !msg.text || msg.text.trim() === '') {
        continue;
      }
      // Convert TOOL to user message — Qwen/Cerebras rejects mid-conversation
      // system turns ("System message must be at the beginning").
      openaiMessages.push({
        role: 'user',
        content: `[Tool Result]\n${msg.text}`,
      });
    } else if (msg.role === 'USER') {
      // Check for file attachment
      if (msg.filePointer) {
        if (isValidFilePointer(msg.filePointer)) {
          // Build multimodal content from file (downloads from storage)
          const content = await buildMultimodalContentFromFile(msg.text, msg.filePointer);
          openaiMessages.push({
            role: 'user',
            content,
          });
        } else {
          // Malformed persisted JSON — degrade to a plain-text attachment
          // marker so routing doesn't crash on bad DB data.
          log.warn('[GeneratorLLM] Invalid filePointer shape, degrading to text', {
            agentId: params.agentId,
          });
          const marker = '[attachment metadata invalid, file unavailable]';
          openaiMessages.push({
            role: 'user',
            content: msg.text ? `${msg.text}\n\n${marker}` : marker,
          });
        }
      } else if (msg.text) {
        openaiMessages.push({ role: 'user', content: msg.text });
      }
      // Skip empty user messages (shouldn't happen but be safe)
    } else if (msg.role === 'ASSISTANT') {
      openaiMessages.push({ role: 'assistant', content: msg.text });
    }
    // Skip SYSTEM messages from DB - we add our own system prompt
  }

  const startTime = Date.now();
  log.info('[GeneratorLLM] Starting streaming response', {
    agentId: params.agentId,
    model: params.model,
    streamId,
    messageCount: openaiMessages.length,
  });

  // Log metadata only — never full message bodies. Multimodal messages
  // carry base64 file data; normal messages carry raw user text. Logging
  // the bodies leaks sensitive data and blows up log volume on attachments.
  log.info('[GeneratorLLM] Context being sent to LLM');
  openaiMessages.forEach((msg, i) => {
    const contentType = typeof msg.content === 'string' ? 'string' : 'array';
    const length = typeof msg.content === 'string' ? msg.content.length : msg.content.length;
    log.info('[GeneratorLLM] Message', {
      index: i,
      role: msg.role,
      contentType,
      length,
    });
  });

  const emitAssistantStream = (
    delta: string,
    done: boolean,
    sequence: number,
    isClaude: boolean,
    isGpt: boolean
  ): Promise<void> => {
    const delivery = (): Promise<void> =>
      broadcastAssistantStream(
        params.agentId,
        streamId,
        delta,
        done,
        sequence,
        isClaude,
        isGpt,
        startTime
      );
    return params.streamGate ? params.streamGate.emit(delivery) : delivery();
  };

  await emitAssistantStream('', false, 0, false, false);
  let attention = createGeneratorAttentionLifecycle({
    agentId: params.agentId,
    streamGate: params.streamGate,
  });
  setAttention(attention);
  await attention.start();

  // Fast Mode: the chat path runs in-process (not through the Python Rose notch),
  // so it caches here. Content-keyed on the conversation so an identical re-ask
  // replays the recorded response. On a hit a one-chunk synthetic stream feeds the
  // existing loop unchanged (still broadcasts + persists). Off → transparent.
  const fastMode = await agentFastMode(params.agentId);
  const fastModeRead = fastMode.enabled === true && fastMode.goal !== null;
  const fastModeWrite = fastMode.writeEnabled === true && fastMode.goal !== null;
  // Button / LLM speed — independent of DEMO cache replay.
  const providerFastMode = fastMode.providerFastMode !== false;
  let fcKey: string | null = null;
  let fcCacheWon = false;
  if ((fastModeRead || fastModeWrite) && fastMode.goal) {
    fcKey = contentKey(fastMode.goal, 'chat_generator', {
      model: params.model,
      response_format: {
        type: 'json_schema',
        name: 'generator_response',
        strict: true,
        schema: GENERATOR_JSON_SCHEMA,
      },
      provider_fast_mode: providerFastMode,
      provider_route: params.providerRoute,
      messages: openaiMessages,
    });
  }
  async function* syntheticChatStream(json: string): AsyncGenerator<CompletionChunk> {
    yield {
      requested_model: params.model,
      actual_model: 'fast-cache',
      pool_name: 'fast-cache',
      pool_size: 0,
      choices: [{ index: 0, delta: { content: json }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  const createLiveStream = (hedgeSignal?: AbortSignal) =>
    createStreamingCompletion(
      buildGeneratorCompletionOptions({
        agentId: params.agentId,
        model: params.model,
        messages: openaiMessages,
        providerRoute: params.providerRoute,
        providerFastMode,
        abortSignal:
          params.abortSignal && hedgeSignal
            ? AbortSignal.any([params.abortSignal, hedgeSignal])
            : (params.abortSignal ?? hedgeSignal),
      })
    );

  let isClaude = false,
    isGpt = false;
  let sequence = 1;
  let lastStreamedText = '';
  const usage = emptyChatLlmUsage();

  const attempted = await regenerateOnChatStructuredMiss({
    callSite: 'chat_generator',
    agentId: params.agentId,
    attempt: async (attempt) => {
      lastStreamedText = '';
      const skipDemoCache = attempt > 1 && fcCacheWon;
      fcCacheWon = false;
      const attemptUsage = emptyChatLlmUsage();
      try {
        if (attempt > 1) {
          await attention.cancel();
          attention = createGeneratorAttentionLifecycle({
            agentId: params.agentId,
            streamGate: params.streamGate,
          });
          setAttention(attention);
          await attention.start();
        }
        // Demo Fast Mode only: wait for cache before Cerebras so a remote hit cannot lose to live.
        // After a cache-won miss, skip cache so the same invalid JSON is not replayed.
        // A live timeout still hedges cache on retry.
        let stream: AsyncIterable<CompletionChunk>;
        if (fcKey && fastModeRead && !skipDemoCache) {
          stream = createGeneratorCacheStream({
            agentId: params.agentId,
            cacheKey: fcKey,
            createLive: (abortSignal) => createLiveStream(abortSignal),
            createCached: syntheticChatStream,
            goal: fastMode.goal,
            onWinner: (winner) => {
              fcCacheWon = winner === 'cache';
            },
          });
        } else {
          if (fcKey) {
            log.info('demo_cache.chat_generator_write_only', {
              agentId: params.agentId,
              key: fcKey,
            });
          }
          stream = await createLiveStream();
        }

        // Track reasoning and JSON content separately (like agent worker)
        let accumulatedReasoning = '', // From delta.reasoning (thinking models)
          accumulatedJson = ''; // From delta.content (JSON structure)
        const structuredOutput = new StructuredOutputAccumulator();
        let chunkCount = 0;
        let actualModel = '';
        let usageData:
          | {
              prompt_tokens: number;
              completion_tokens: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
              finish_reason?: string;
            }
          | undefined;

        // Process stream chunks - stream every delta immediately
        for await (const chunk of stream) {
          chunkCount++;

          // Detect user's Claude token usage from "-claude" suffix in actual_model
          if (chunk.actual_model) actualModel = chunk.actual_model;
          if (chunk.usage)
            usageData = {
              ...chunk.usage,
              finish_reason: chunk.choices[0]?.finish_reason ?? undefined,
            };
          if (!isClaude && actualModel?.endsWith('-claude')) {
            isClaude = true;
          }
          if (!isGpt && (actualModel?.endsWith('-gpt') || actualModel?.endsWith('-foundry'))) {
            isGpt = true;
          }

          // Get delta from chunk
          const delta = chunk.choices[0]?.delta;

          // Handle reasoning from thinking models (delta.reasoning)
          const reasoningDelta = delta?.reasoning || '';
          if (reasoningDelta) {
            accumulatedReasoning += reasoningDelta;
          }

          // Handle JSON content (delta.content)
          const contentDelta = delta?.content || '';
          if (contentDelta) {
            structuredOutput.addCompletionChunk(chunk);
            accumulatedJson = structuredOutput.currentText();
          }

          const streamableText = extractStreamableReasoning(accumulatedReasoning, accumulatedJson);

          if (streamableText && streamableText !== lastStreamedText) {
            const newText = streamableText.slice(lastStreamedText.length);
            lastStreamedText = streamableText;

            // Stream every delta immediately
            if (newText) {
              await emitAssistantStream(newText, false, sequence++, isClaude, isGpt);
            }
          }

          const accumulatedResponse = extractPartialStringField(accumulatedJson, 'response');
          if (accumulatedResponse) await attention.update(accumulatedResponse);

          if (chunk.usage) {
            applyChunkUsage(attemptUsage, chunk.usage);
          }

          // Log progress every 50 chunks
          if (chunkCount % 50 === 0) {
            log.info('[GeneratorLLM] Progress', {
              chunk: chunkCount,
              reasoning: accumulatedReasoning.length,
              json: accumulatedJson.length,
              streamed: sequence,
            });
          }
        }

        const fullJson = structuredOutput.currentText();
        const parsed = requireGeneratorParsedJson(fullJson);
        return {
          fullJson,
          parsed,
          usageData,
          actualModel,
          chunkCount,
          reasoningLength: accumulatedReasoning.length,
        };
      } finally {
        accumulateChatLlmUsage(usage, attemptUsage);
      }
    },
  });

  const { fullJson, parsed, usageData, actualModel, chunkCount, reasoningLength } = attempted;

  // Fast Mode: record the generator response so an identical re-ask replays it.
  const cacheGoal = fastMode.goal;
  const committed = await runAfterStreamCommit(params.streamGate, async () => {
    if (fcKey && !fcCacheWon && fullJson !== '' && cacheGoal !== null && fastModeWrite) {
      runCacheWriteInBackground(
        () =>
          cacheSet({
            key: fcKey,
            kind: 'llm',
            goalHash: goalHash(cacheGoal),
            value: { json: fullJson },
          }),
        () => log.info('demo_cache.chat_generator_stored', { agentId: params.agentId, key: fcKey }),
        (error) =>
          log.warn('demo_cache.chat_generator_store_failed', {
            agentId: params.agentId,
            key: fcKey,
            error: error instanceof Error ? error.message : String(error),
          })
      );
    }
  });
  if (!committed) {
    await attention.cancel();
    throw new Error('Early generator result discarded before Router commit');
  }

  // Broadcast final "done" signal
  await emitAssistantStream('', true, sequence, isClaude, isGpt);

  const streamDuration = Date.now() - startTime;
  log.info('[GeneratorLLM] Streaming complete', {
    agentId: params.agentId,
    streamId,
    durationMs: streamDuration,
    chunksReceived: chunkCount,
    chunksStreamed: sequence,
    reasoningLength,
    jsonLength: fullJson.length,
  });

  if (usageData) {
    const cacheRead = usageData.cache_read_input_tokens ?? 0;
    const cacheWrite = usageData.cache_creation_input_tokens ?? 0;
    const promptTokens = usageData.prompt_tokens ?? 0;
    const totalInput = promptTokens + cacheRead + cacheWrite;
    const cacheHitPct = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;
    log.info('llm.cache', {
      call_site: 'generatorLlm',
      agent_id: params.agentId,
      actual_model: actualModel,
      is_claude: isClaude,
      is_gpt: isGpt,
      prompt_tokens: promptTokens,
      completion_tokens: usageData.completion_tokens ?? 0,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cache_hit_pct: cacheHitPct,
      finish: usageData.finish_reason ?? 'unknown',
    });
  }

  log.info('[GeneratorLLM] Response parsed successfully', {
    agentId: params.agentId,
    streamId,
    totalDurationMs: Date.now() - startTime,
    reasoningLength: parsed.reasoning?.length || 0,
    responseLength: parsed.response?.length || 0,
  });

  const userTexts = params.messages
    .filter((message) => message.role === 'USER' && typeof message.text === 'string')
    .map((message) => message.text);
  const response = ensureVerbatimIncludes(userTexts, parsed.response || '');
  if (response !== (parsed.response || '')) {
    log.warn('[GeneratorLLM] Appended missing Include-verbatim token(s)', {
      agentId: params.agentId,
      streamId,
      beforeLength: (parsed.response || '').length,
      afterLength: response.length,
    });
  }

  await attention.complete(response);

  usage.model = actualModel || params.model;
  usage.from_fast_cache = fcCacheWon;

  return {
    reasoning: parsed.reasoning || '',
    response,
    streamId,
    toolCallId: attention.toolCallId,
    usage,
  };
}
