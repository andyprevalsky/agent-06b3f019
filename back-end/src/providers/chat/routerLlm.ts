/**
 * Router LLM - First step in chat mode.
 * Analyzes user intent and decides: direct_answer | web_search | agent_start_task
 * Uses the in-process Rose completions client for streaming.
 */

import { createStreamingCompletion, type CompletionChunk, type CompletionOptions } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { agentFastMode, cacheSet } from '../demoCacheStore';
import { goalHash } from '../demoCacheNormalizeCore';
import { contentKey } from '../demoCacheNormalizeKeys';
import { ROUTER_STAGES, buildRouterSystemMessage } from './chatSystemContext';
export { buildRouterSystemMessage } from './chatSystemContext';
import {
  broadcastAssistantStream,
  broadcastToolEvent,
  generateStreamId,
} from './supabaseBroadcast';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger';
import { isCloudAgentLifecycleTool } from './cloudAgentLifecycleTool';
import {
  createClosedRouterActionDetector,
  extractPartialStringField,
  getWebSearchStreamTitleFromPartialRouterJson,
  type ClosedRouterAction,
} from './routerJsonStream';
import { delayedCacheStreamHedge } from './delayedCacheStreamHedge';
import { isOpeningRouterTurn, readRouterDemoCache } from './routerDemoCache';
import { isOaiDemoGoal } from '../demoCacheNormalizeOaiDemo';
import type { ChatProviderRoute } from './phaseModels';
import type { ChatCompletionParams } from './completionOptions';
import { withCurrentTimeContext } from '../currentTimeContext';
import { runCacheWriteInBackground } from './backgroundCacheWrite';
import {
  chatRouterCompletionTimeoutMs,
  createRouterCompletionDeadline,
  streamBeforeRouterCompletionDeadline,
} from './routerCompletionDeadline';
import { regenerateOnChatStructuredMiss } from './chatStructuredRetry';
import {
  buildMultimodalContentFromFile,
  isValidFilePointer,
  type MultimodalContentBlock,
} from './chatMultimodal';
import {
  finalizeRouterDecisionFromStream,
  requireRouterDecision,
  type RouterDecision,
  type RouterStage,
} from './routerDecision';

export { RouterDecisionSchema } from './routerDecision';
export type { RouterDecision } from './routerDecision';

const log = createLogger('RouterLLM');

/**
 * What differs between the turn's first route and the routes after its web
 * searches. A separate call site keeps after-search routes out of the first
 * route's DEMO cache rows (including the opening-turn drift replay) and
 * apart in LLM dumps. Once the search rounds are spent, web_search is gone.
 */
const ROUTER_CACHE_HANG_MS = 5_000;
// Routing is a classification step; sampling can escalate a one-search chat request to agent mode.
const ROUTER_TEMPERATURE = 0;

// ============================================
// Router Response with streaming metadata
// ============================================
export interface ChatLlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  model: string;
  from_fast_cache: boolean;
}

export function emptyChatLlmUsage(): ChatLlmUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    model: '',
    from_fast_cache: false,
  };
}

export function applyChunkUsage(
  target: ChatLlmUsage,
  chunkUsage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }
): void {
  target.prompt_tokens = chunkUsage.prompt_tokens ?? 0;
  target.completion_tokens = chunkUsage.completion_tokens ?? 0;
  target.total_tokens = chunkUsage.total_tokens ?? 0;
  target.cache_creation_input_tokens = chunkUsage.cache_creation_input_tokens ?? 0;
  target.cache_read_input_tokens = chunkUsage.cache_read_input_tokens ?? 0;
}

export function accumulateChatLlmUsage(target: ChatLlmUsage, increment: ChatLlmUsage): void {
  target.prompt_tokens += increment.prompt_tokens;
  target.completion_tokens += increment.completion_tokens;
  target.total_tokens += increment.total_tokens;
  target.cache_creation_input_tokens += increment.cache_creation_input_tokens;
  target.cache_read_input_tokens += increment.cache_read_input_tokens;
}

export interface RouterResponse {
  decision: RouterDecision;
  streamId: string;
  webSearchToolCallId?: string;
  usage: ChatLlmUsage;
}

interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  filePointer?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export { getWebSearchStreamTitleFromPartialRouterJson } from './routerJsonStream';

// ============================================
// Extract streamable text from partial JSON (like agent worker)
// For router, we only stream reasoning
// ============================================
function extractStreamableReasoning(
  accumulatedReasoning: string,
  accumulatedJson: string
): string | null {
  // Prefer reasoning from delta.reasoning (thinking models)
  if (accumulatedReasoning.trim()) {
    return accumulatedReasoning.trim();
  }

  // Fall back to reasoning field from JSON
  const jsonReasoning = extractPartialStringField(accumulatedJson, 'reasoning');
  return jsonReasoning?.trim() || null;
}

// ============================================
// Router LLM Call with Streaming
// ============================================
export function buildRouterCompletionOptions(
  params: ChatCompletionParams & { stage?: RouterStage }
): CompletionOptions {
  return {
    model: params.model,
    messages: withCurrentTimeContext(params.messages),
    temperature: ROUTER_TEMPERATURE,
    // Cerebras reserves the model's full sequence length when this is omitted,
    // exhausting the shared token quota even for a short routing decision.
    ...(params.providerRoute === 'direct-cerebras' ? { max_tokens: 2_048 } : {}),
    // The router is a small structured classification step. Gemini 3.5 Flash
    // enables medium reasoning by default on OpenRouter, which can consume most
    // of the synchronous chat latency budget after a Cerebras stall. Keep its
    // mandatory reasoning at the provider's minimum, just like the generator.
    effort: 'minimal',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'router_decision',
        strict: true,
        schema: ROUTER_STAGES[params.stage ?? 'initial'].schema,
      },
    },
    dump_context: {
      agent_id: params.agentId,
      call_site: ROUTER_STAGES[params.stage ?? 'initial'].callSite,
    },
    speed: params.speed,
    ...(params.providerRoute !== undefined ? { provider_route: params.providerRoute } : {}),
    abort_signal: params.abortSignal,
  };
}

export async function callRouterLlm(params: {
  agentId: string;
  messages: ChatMessage[];
  model: string;
  providerRoute?: ChatProviderRoute;
  stage?: RouterStage;
  userProfileContext?: string;
  projectContext?: string; // `## Project` section; '' or omitted = Home
  onRouterStarted?: () => void;
  onActionDetected?: (action: ClosedRouterAction) => void;
}): Promise<RouterResponse> {
  const streamId = generateStreamId();
  const stage = params.stage ?? 'initial';
  const routerStage = ROUTER_STAGES[stage];

  // Convert messages to OpenAI format (with multimodal support).
  // The system prompt is wrapped in `markCacheable` so the static prefix is
  // explicitly tagged for Anthropic prompt caching at the call-site level.
  // See back-end/src/providers/rose/cache.ts for the helper contract.
  const openaiMessages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | MultimodalContentBlock[];
  }> = [buildRouterSystemMessage(stage, params.projectContext, params.userProfileContext)];

  for (const msg of params.messages) {
    if (msg.role === 'TOOL') {
      // Skip UI-only lifecycle tools and IN_PROGRESS messages.
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
          log.warn('[RouterLLM] Invalid filePointer shape, degrading to text', {
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
  }

  const startTime = Date.now();
  log.info('[RouterLLM] Starting streaming for routing decision', {
    agentId: params.agentId,
    model: params.model,
    streamId,
    messageCount: openaiMessages.length,
  });

  await broadcastAssistantStream(params.agentId, streamId, '', false, 0, false, false, startTime);
  params.onRouterStarted?.();

  const fastMode = await agentFastMode(params.agentId);
  const fastModeRead = fastMode.enabled === true && fastMode.goal !== null;
  const fastModeWrite = fastMode.writeEnabled === true && fastMode.goal !== null;
  // Legacy Fast Mode bit: part of the DEMO cache key namespace only. Provider
  // speed is fastMode.speed and never changes which cache entry is read.
  const providerFastMode = fastMode.providerFastMode !== false;
  let fcKey: string | null = null;
  let fcCacheWon = false;
  const driftGoal = fastModeRead && isOpeningRouterTurn(openaiMessages) ? fastMode.goal : null;
  if ((fastModeRead || fastModeWrite) && fastMode.goal) {
    fcKey = contentKey(fastMode.goal, routerStage.callSite, {
      model: params.model,
      temperature: ROUTER_TEMPERATURE,
      effort: 'minimal',
      response_format: {
        type: 'json_schema',
        name: 'router_decision',
        strict: true,
        schema: routerStage.schema,
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

  const completionTimeoutMs = chatRouterCompletionTimeoutMs();
  let isClaude = false;
  let isGpt = false;
  let sequence = 1;
  let lastStreamedText = '';
  let webSearchToolCallId: string | undefined;
  let webSearchDetected = false;
  const usage = emptyChatLlmUsage();

  const attempted = await regenerateOnChatStructuredMiss({
    callSite: 'chat_router',
    agentId: params.agentId,
    attempt: async (attempt) => {
      lastStreamedText = '';
      const skipDemoCache = attempt > 1 && fcCacheWon;
      fcCacheWon = false;
      const attemptUsage = emptyChatLlmUsage();
      try {
        if (webSearchToolCallId) {
          await broadcastToolEvent(
            params.agentId,
            streamId,
            webSearchToolCallId,
            'web_search',
            'ERROR',
            'Search interrupted',
            0,
            isClaude,
            isGpt,
            startTime
          );
          webSearchToolCallId = undefined;
          webSearchDetected = false;
        }
        const detectClosedAction = createClosedRouterActionDetector(params.onActionDetected);
        const completionDeadline = createRouterCompletionDeadline(completionTimeoutMs);
        const createLiveStream = (abortSignal?: AbortSignal) =>
          createStreamingCompletion(
            buildRouterCompletionOptions({
              agentId: params.agentId,
              model: params.model,
              messages: openaiMessages,
              providerRoute: params.providerRoute,
              stage,
              speed: fastMode.speed,
              abortSignal: abortSignal
                ? AbortSignal.any([abortSignal, completionDeadline.signal])
                : completionDeadline.signal,
            })
          );

        let stream: AsyncIterable<CompletionChunk>;
        if (fcKey && fastModeRead && !skipDemoCache) {
          const cacheKey = fcKey;
          stream = delayedCacheStreamHedge({
            readCache: () => readRouterDemoCache({ agentId: params.agentId, cacheKey, driftGoal }),
            createLive: (abortSignal) => createLiveStream(abortSignal),
            createCached: syntheticChatStream,
            isLiveCommitChunk: (chunk) => {
              const delta = chunk.choices[0]?.delta;
              return Boolean(delta?.content?.length || delta?.reasoning?.length);
            },
            awaitCacheFirst: isOaiDemoGoal(fastMode.goal),
            hangTimeoutMs: ROUTER_CACHE_HANG_MS,
            onCacheError: (error) =>
              log.warn('demo_cache.chat_router_read_failed', {
                agentId: params.agentId,
                key: cacheKey,
                error: error instanceof Error ? error.message : String(error),
              }),
            onWinner: (winner) => {
              fcCacheWon = winner === 'cache';
            },
          });
        } else {
          if (fcKey) {
            log.info('demo_cache.chat_router_write_only', { agentId: params.agentId, key: fcKey });
          }
          stream = await createLiveStream().catch((error: unknown) => {
            completionDeadline.dispose();
            throw error;
          });
        }

        // Track reasoning and JSON content separately (like agent worker)
        let accumulatedReasoning = ''; // From delta.reasoning (thinking models)
        let accumulatedJson = ''; // From delta.content (JSON structure)
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
        for await (const chunk of streamBeforeRouterCompletionDeadline(
          stream,
          completionDeadline
        )) {
          chunkCount++;

          // Detect user's Claude token usage from "-claude" suffix in actual_model
          // e.g. "claude-sonnet-4-6-claude" = user token ($0), "anthropic/claude-sonnet-4.6" = waterfall ($)
          if (chunk.actual_model) actualModel = chunk.actual_model;
          if (chunk.usage)
            usageData = {
              ...chunk.usage,
              finish_reason: chunk.choices[0]?.finish_reason ?? undefined,
            };
          if (chunkCount === 1) {
            log.info('[RouterLLM] First chunk', {
              actualModel,
              requestedModel: chunk.requested_model,
            });
          }
          if (!isClaude && actualModel?.endsWith('-claude')) {
            isClaude = true;
            log.info('[RouterLLM] User Claude token detected', { actualModel });
          }
          if (!isGpt && (actualModel?.endsWith('-gpt') || actualModel?.endsWith('-foundry'))) {
            isGpt = true;
            log.info('[RouterLLM] User GPT token detected', { actualModel });
          }

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
            detectClosedAction(accumulatedJson);
          }

          // Extract streamable reasoning text
          const streamableText = extractStreamableReasoning(accumulatedReasoning, accumulatedJson);

          if (streamableText && streamableText !== lastStreamedText) {
            const newText = streamableText.slice(lastStreamedText.length);
            lastStreamedText = streamableText;

            // Stream every delta immediately
            if (newText) {
              await broadcastAssistantStream(
                params.agentId,
                streamId,
                newText,
                false,
                sequence++,
                isClaude,
                isGpt,
                startTime
              );
            }
          }

          // Detect web_search once the streamed JSON includes the complete query.
          if (stage !== 'search_budget_spent' && !webSearchDetected) {
            const webSearchStreamTitle =
              getWebSearchStreamTitleFromPartialRouterJson(accumulatedJson);
            if (webSearchStreamTitle) {
              webSearchDetected = true;
              webSearchToolCallId = uuidv4();
              log.info('[RouterLLM] Detected web_search early, emitting IN_PROGRESS', {
                toolCallId: webSearchToolCallId,
              });
              await broadcastToolEvent(
                params.agentId,
                streamId,
                webSearchToolCallId,
                'web_search',
                'IN_PROGRESS',
                webSearchStreamTitle,
                accumulatedReasoning.length + accumulatedJson.length,
                isClaude,
                isGpt,
                startTime
              );
            }
          }

          if (chunk.usage) {
            applyChunkUsage(attemptUsage, chunk.usage);
          }

          // Log progress every 50 chunks
          if (chunkCount % 50 === 0) {
            log.info('[RouterLLM] Progress', {
              chunk: chunkCount,
              reasoning: accumulatedReasoning.length,
              json: accumulatedJson.length,
              streamed: sequence,
            });
          }
        }

        const deadlineExpired = completionDeadline.expired();
        const finalized = finalizeRouterDecisionFromStream({
          structuredOutput,
          accumulatedJson,
          deadlineExpired,
        });
        if (!finalized.decision && deadlineExpired) {
          log.warn('[RouterLLM] Completion deadline expired without a decision', {
            agentId: params.agentId,
            attempt,
            timeoutMs: completionTimeoutMs,
            elapsedMs: Date.now() - startTime,
            actualModel,
            chunksReceived: chunkCount,
            jsonLength: accumulatedJson.length,
          });
          if (webSearchToolCallId) {
            await broadcastToolEvent(
              params.agentId,
              streamId,
              webSearchToolCallId,
              'web_search',
              'ERROR',
              'Search interrupted',
              0,
              isClaude,
              isGpt,
              startTime
            );
            webSearchToolCallId = undefined;
            webSearchDetected = false;
          }
          await broadcastAssistantStream(
            params.agentId,
            streamId,
            '',
            true,
            sequence,
            isClaude,
            isGpt,
            startTime,
            { clearOnDone: true }
          );
        }
        const decision = requireRouterDecision({ finalized, deadlineExpired, stage });
        if (deadlineExpired) {
          log.warn('[RouterLLM] Completion deadline recovered a closed decision', {
            agentId: params.agentId,
            action: decision.action,
            timeoutMs: completionTimeoutMs,
            chunksReceived: chunkCount,
            jsonLength: accumulatedJson.length,
          });
        }

        return {
          decision,
          fullJson: finalized.fullJson,
          deadlineRecovered: deadlineExpired,
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

  const {
    decision,
    fullJson,
    deadlineRecovered,
    usageData,
    actualModel,
    chunkCount,
    reasoningLength,
  } = attempted;

  // Broadcast final "done" signal for reasoning stream
  await broadcastAssistantStream(
    params.agentId,
    streamId,
    '',
    true,
    sequence,
    isClaude,
    isGpt,
    startTime,
    { clearOnDone: true }
  );

  const streamDuration = Date.now() - startTime;
  log.info('[RouterLLM] Streaming complete', {
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
      call_site: 'routerLlm',
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

  const cacheGoal = fastMode.goal;
  if (fcKey && !fcCacheWon && !deadlineRecovered && cacheGoal !== null && fastModeWrite) {
    runCacheWriteInBackground(
      () =>
        cacheSet({
          key: fcKey,
          kind: 'llm',
          goalHash: goalHash(cacheGoal),
          value: { json: fullJson },
        }),
      () => log.info('demo_cache.chat_router_stored', { agentId: params.agentId, key: fcKey }),
      (error) =>
        log.warn('demo_cache.chat_router_store_failed', {
          agentId: params.agentId,
          key: fcKey,
          error: error instanceof Error ? error.message : String(error),
        })
    );
  }

  log.info('[RouterLLM] Decision', {
    action: decision.action,
    reasoning: decision.reasoning.substring(0, 100),
    streamedChunks: sequence,
  });

  usage.model = actualModel || params.model;
  usage.from_fast_cache = fcCacheWon;

  return {
    decision,
    streamId,
    webSearchToolCallId,
    usage,
  };
}
