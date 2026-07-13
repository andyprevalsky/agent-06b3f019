/**
 * Router LLM - First step in chat mode.
 * Analyzes user intent and decides: direct_answer | web_search | agent_start_task
 * Uses the in-process Rose completions client for streaming.
 */

import { z } from 'zod';
import { createStreamingCompletion, markCacheable, type CompletionChunk } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { agentFastMode, cacheGet, cacheSet } from '../fastCacheStore';
import { goalHash } from '../fastCacheNormalizeCore';
import { contentKey } from '../fastCacheNormalizeKeys';
import { ROUTER_SYSTEM_PROMPT } from './chatPrompts';
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
import { delayedCacheStreamHedge, type CacheLookupResult } from './delayedCacheStreamHedge';
import type { ChatProviderRoute } from './phaseModels';
import { runCacheWriteInBackground } from './backgroundCacheWrite';

const log = createLogger('RouterLLM');
const ROUTER_CACHE_GRACE_MS = 25;

// ============================================
// Zod Schema for Router Decision
// ============================================
export const RouterDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('direct_answer'),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('web_search'),
    reasoning: z.string(),
    query: z.string(),
  }),
  z.object({
    action: z.literal('start_superintelligence'),
    reasoning: z.string(),
    goal: z.string(),
    mode: z.enum(['plan', 'execute']), // plan for 3+ tool calls, execute for 1-2
  }),
]);

export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

// ============================================
// Router Response with streaming metadata
// ============================================
export interface ChatLlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface RouterResponse {
  decision: RouterDecision;
  streamId: string;
  webSearchToolCallId?: string;
  usage: ChatLlmUsage;
}

// ============================================
// JSON Schema for structured output (universal compatibility)
// Flat object with all fields required - works across OpenAI, Anthropic, and Gemini
// Action-specific fields use empty string when not applicable
// ============================================
const ROUTER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Brief explanation of why this action was chosen',
    },
    action: {
      type: 'string',
      enum: ['direct_answer', 'web_search', 'start_superintelligence'],
      description: 'The action to take',
    },
    query: {
      type: 'string',
      description: 'Search query. Required for web_search, empty string for other actions.',
    },
    goal: {
      type: 'string',
      description:
        'Task goal for the agent. Required for start_superintelligence, empty string for other actions.',
    },
    mode: {
      type: 'string',
      // Enum constraint mirrors the Zod discriminated-union (z.enum(['plan',
      // 'execute']) above) so structured-output validation rejects any
      // out-of-band value (e.g. "research") instead of silently coercing to
      // 'plan' at the `raw.mode || 'plan'` fallback below. The runtime only
      // reads `mode` when action === 'start_superintelligence'; for the other
      // two actions, the value is ignored, so the LLM may pick either of the
      // enum members without effect.
      enum: ['plan', 'execute'],
      description:
        'Execution mode: "plan" for 3+ tool calls, "execute" for 1-2 tool calls. Required for start_superintelligence; ignored for other actions (pick either enum value).',
    },
  },
  required: ['reasoning', 'action', 'query', 'goal', 'mode'],
  additionalProperties: false,
};

import { downloadFromStorage } from '../storage';

// FilePointer interface for type safety when processing
interface FilePointer {
  id: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

// Runtime validation — DB JSON must match the FilePointer shape before we
// trust it enough to call downloadFromStorage() or build a multimodal block.
function isValidFilePointer(value: unknown): value is FilePointer {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.storage_path === 'string' &&
    v.storage_path.length > 0 &&
    typeof v.mime_type === 'string' &&
    v.mime_type.length > 0 &&
    typeof v.size_bytes === 'number' &&
    Number.isFinite(v.size_bytes) &&
    v.size_bytes >= 0 &&
    typeof v.original_filename === 'string'
  );
}

// ============================================
// Message format for LLM calls
// ============================================
interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  filePointer?: Record<string, unknown>; // FilePointer from DB JSON - validated at runtime
  metadata?: Record<string, unknown>;
}

// File size threshold for inline content (20MB)
const LLM_INLINE_THRESHOLD = 20 * 1024 * 1024;

// File type helpers
const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/json',
  'application/xml',
]);

// ============================================
// Build multimodal content from a file pointer
// Downloads from storage and converts to base64 for LLM
// ============================================
type MultimodalContentBlock = {
  type: string;
  text?: string;
  image_url?: { url: string };
  file?: { filename: string; file_data: string };
};

async function buildMultimodalContentFromFile(
  text: string,
  filePointer: FilePointer
): Promise<MultimodalContentBlock[]> {
  const content: MultimodalContentBlock[] = [];

  // File too large for inline content
  if (filePointer.size_bytes >= LLM_INLINE_THRESHOLD) {
    const sizeStr = (filePointer.size_bytes / 1024 / 1024).toFixed(1);
    content.push({
      type: 'text',
      text: text
        ? `${text}\n\n[Attached: ${filePointer.original_filename} (${sizeStr}MB) - too large for inline viewing]`
        : `[Attached: ${filePointer.original_filename} (${sizeStr}MB) - too large for inline viewing]`,
    });
    return content;
  }

  try {
    // Download file from storage
    const fileBuffer = await downloadFromStorage(filePointer.storage_path);
    const base64 = fileBuffer.toString('base64');

    if (IMAGE_MIME_TYPES.has(filePointer.mime_type)) {
      // Image: add as image_url content block
      if (text) {
        content.push({ type: 'text', text });
      }
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${filePointer.mime_type};base64,${base64}`,
        },
      });
    } else if (
      TEXT_MIME_TYPES.has(filePointer.mime_type) ||
      filePointer.mime_type.startsWith('text/')
    ) {
      // Text file: decode and add as text
      const decoded = fileBuffer.toString('utf-8');
      content.push({
        type: 'text',
        text: text
          ? `${text}\n\n[File: ${filePointer.original_filename}]\n\`\`\`\n${decoded}\n\`\`\``
          : `[File: ${filePointer.original_filename}]\n\`\`\`\n${decoded}\n\`\`\``,
      });
    } else if (filePointer.mime_type === 'application/pdf') {
      // PDF: add as file block (for capable models)
      if (text) {
        content.push({ type: 'text', text });
      }
      content.push({
        type: 'file',
        file: {
          filename: filePointer.original_filename,
          file_data: `data:${filePointer.mime_type};base64,${base64}`,
        },
      });
    } else {
      // Other file types: just metadata
      content.push({
        type: 'text',
        text: text
          ? `${text}\n\n[Attached: ${filePointer.original_filename} (${filePointer.mime_type})]`
          : `[Attached: ${filePointer.original_filename} (${filePointer.mime_type})]`,
      });
    }
  } catch (error) {
    log.error('[RouterLLM] Failed to download file from storage', {
      error: error instanceof Error ? error.message : String(error),
    });
    content.push({
      type: 'text',
      text: text
        ? `${text}\n\n[Attached: ${filePointer.original_filename} - failed to load]`
        : `[Attached: ${filePointer.original_filename} - failed to load]`,
    });
  }

  return content;
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
export async function callRouterLlm(params: {
  agentId: string;
  messages: ChatMessage[];
  model: string;
  providerRoute: ChatProviderRoute;
  onRouterStarted?: () => void;
  onActionDetected?: (action: ClosedRouterAction) => void;
}): Promise<RouterResponse> {
  const streamId = generateStreamId();

  // Convert messages to OpenAI format (with multimodal support).
  // The system prompt is wrapped in `markCacheable` so the static prefix is
  // explicitly tagged for Anthropic prompt caching at the call-site level.
  // See back-end/src/providers/rose/cache.ts for the helper contract.
  const openaiMessages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | MultimodalContentBlock[];
  }> = [markCacheable(ROUTER_SYSTEM_PROMPT)];

  for (const msg of params.messages) {
    if (msg.role === 'TOOL') {
      // Skip UI-only lifecycle tools and IN_PROGRESS messages.
      if (isCloudAgentLifecycleTool(msg.metadata) || !msg.text || msg.text.trim() === '') {
        continue;
      }
      // Convert TOOL to system message with content (matches worker pattern)
      openaiMessages.push({
        role: 'system',
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
  const providerFastMode = fastModeRead || fastModeWrite;
  let fcKey: string | null = null;
  let fcCacheWon = false;
  if ((fastModeRead || fastModeWrite) && fastMode.goal) {
    fcKey = contentKey(fastMode.goal, 'chat_router', {
      model: params.model,
      temperature: 0.3,
      response_format: {
        type: 'json_schema',
        name: 'router_decision',
        strict: true,
        schema: ROUTER_JSON_SCHEMA,
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

  const createLiveStream = (abortSignal?: AbortSignal) =>
    createStreamingCompletion({
      model: params.model,
      messages: openaiMessages,
      temperature: 0.3,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'router_decision',
          strict: true,
          schema: ROUTER_JSON_SCHEMA,
        },
      },
      provider_fast_mode: providerFastMode,
      provider_route: params.providerRoute,
      abort_signal: abortSignal,
    });

  let stream: AsyncIterable<CompletionChunk>;
  if (fcKey && fastModeRead) {
    const cacheKey = fcKey;
    stream = delayedCacheStreamHedge({
      readCache: async (): Promise<CacheLookupResult<string>> => {
        const hit = await cacheGet(cacheKey);
        const json = hit.hit ? (hit.value as { json?: unknown } | null)?.json : undefined;
        if (typeof json === 'string' && json.length > 0) {
          log.info('fast_cache.chat_router_hit', { agentId: params.agentId, key: cacheKey });
          return { hit: true, value: json };
        }
        log.info('fast_cache.chat_router_miss', { agentId: params.agentId, key: cacheKey });
        return { hit: false };
      },
      createLive: (abortSignal) => createLiveStream(abortSignal),
      createCached: syntheticChatStream,
      isLiveCommitChunk: (chunk) => {
        const delta = chunk.choices[0]?.delta;
        return Boolean(delta?.content?.length || delta?.reasoning?.length);
      },
      graceMs: ROUTER_CACHE_GRACE_MS,
      onCacheError: (error) =>
        log.warn('fast_cache.chat_router_read_failed', {
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
      log.info('fast_cache.chat_router_write_only', { agentId: params.agentId, key: fcKey });
    }
    stream = await createLiveStream();
  }

  // isClaude = user's own Claude token was used ($0 cost, "-claude" suffix in actual_model)
  let isClaude = false;
  let isGpt = false;

  // Track reasoning and JSON content separately (like agent worker)
  let accumulatedReasoning = ''; // From delta.reasoning (thinking models)
  let accumulatedJson = ''; // From delta.content (JSON structure)
  const structuredOutput = new StructuredOutputAccumulator();
  let sequence = 1;
  let lastStreamedText = ''; // What we've sent to FE so far
  let chunkCount = 0;
  let webSearchToolCallId: string | undefined;
  let webSearchDetected = false;
  const detectClosedAction = createClosedRouterActionDetector(params.onActionDetected);
  const usage: ChatLlmUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
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
    // e.g. "claude-sonnet-4-6-claude" = user token ($0), "anthropic/claude-sonnet-4.6" = waterfall ($)
    if (chunk.actual_model) actualModel = chunk.actual_model;
    if (chunk.usage)
      usageData = { ...chunk.usage, finish_reason: chunk.choices[0]?.finish_reason ?? undefined };
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
    if (!isGpt && actualModel?.endsWith('-gpt')) {
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
    if (!webSearchDetected) {
      const webSearchStreamTitle = getWebSearchStreamTitleFromPartialRouterJson(accumulatedJson);
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
      usage.prompt_tokens = chunk.usage.prompt_tokens ?? 0;
      usage.completion_tokens = chunk.usage.completion_tokens ?? 0;
      usage.total_tokens = chunk.usage.total_tokens ?? 0;
      usage.cache_creation_input_tokens = chunk.usage.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens = chunk.usage.cache_read_input_tokens ?? 0;
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

  // Combine for parsing - use accumulatedJson for JSON parsing
  const fullJson = structuredOutput.finalText();

  const cacheGoal = fastMode.goal;
  if (fcKey && !fcCacheWon && fullJson !== '' && cacheGoal !== null && fastModeWrite) {
    runCacheWriteInBackground(
      () =>
        cacheSet({
          key: fcKey,
          kind: 'llm',
          goalHash: goalHash(cacheGoal),
          value: { json: fullJson },
        }),
      () => log.info('fast_cache.chat_router_stored', { agentId: params.agentId, key: fcKey }),
      (error) =>
        log.warn('fast_cache.chat_router_store_failed', {
          agentId: params.agentId,
          key: fcKey,
          error: error instanceof Error ? error.message : String(error),
        })
    );
  }

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
    reasoningLength: accumulatedReasoning.length,
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

  // Parse the complete JSON
  if (!fullJson) {
    log.error('[RouterLLM] No content received from LLM', {
      agentId: params.agentId,
      streamId,
    });
    throw new Error('Router LLM returned no content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fullJson);
  } catch (error) {
    log.error('[RouterLLM] Failed to parse JSON response', {
      agentId: params.agentId,
      streamId,
      error: error instanceof Error ? error.message : String(error),
      jsonPreview: fullJson.substring(0, 500),
    });
    throw new Error(`Failed to parse router response as JSON: ${fullJson.substring(0, 200)}`);
  }

  const raw = parsed as {
    reasoning: string;
    action: 'direct_answer' | 'web_search' | 'start_superintelligence';
    query?: string;
    goal?: string;
    mode?: 'plan' | 'execute';
  };

  // Validate action-specific fields
  if (raw.action === 'web_search' && !raw.query) {
    throw new Error('web_search action requires a query');
  }
  if (raw.action === 'start_superintelligence' && !raw.goal) {
    throw new Error('start_superintelligence action requires a goal');
  }

  // Construct the properly typed decision
  let decision: RouterDecision;
  switch (raw.action) {
    case 'direct_answer':
      decision = { action: 'direct_answer', reasoning: raw.reasoning };
      break;
    case 'web_search':
      decision = { action: 'web_search', reasoning: raw.reasoning, query: raw.query! };
      break;
    case 'start_superintelligence':
      // Default to 'plan' if mode not provided (backward compatibility)
      decision = {
        action: 'start_superintelligence',
        reasoning: raw.reasoning,
        goal: raw.goal!,
        mode: raw.mode || 'plan',
      };
      break;
    default:
      throw new Error(`Unknown action: ${raw.action}`);
  }

  log.info('[RouterLLM] Decision', {
    action: decision.action,
    reasoning: decision.reasoning.substring(0, 100),
    streamedChunks: sequence,
  });

  return {
    decision,
    streamId,
    webSearchToolCallId,
    usage,
  };
}
