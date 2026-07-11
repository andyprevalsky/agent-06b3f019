/**
 * Generator LLM - Second step in chat mode.
 * Generates the user-facing response with streaming support.
 * Uses the in-process Rose completions client.
 * Uses structured output with separate reasoning (thinking) and response (true message) fields.
 */

import { createStreamingCompletion, markCacheable } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { agentFastMode, cacheGet, cacheSet } from '../fastCacheStore';
import { goalHash } from '../fastCacheNormalizeCore';
import { contentKey } from '../fastCacheNormalizeKeys';
import { GENERATOR_SYSTEM_PROMPT } from './chatPrompts';
import { broadcastAssistantStream, generateStreamId } from './supabaseBroadcast';
import { downloadFromStorage } from '../storage';
import { createLogger } from '../logger';
import type { ChatLlmUsage } from './routerLlm';
import { isCloudAgentLifecycleTool } from './cloudAgentLifecycleTool';

const log = createLogger('GeneratorLLM');

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
    log.error('[GeneratorLLM] Failed to download file from storage', {
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

// ============================================
// Generator Response
// ============================================
export interface GeneratorResponse {
  reasoning: string;
  response: string;
  streamId: string;
  usage: ChatLlmUsage;
}

// ============================================
// JSON Schema for structured output
// ============================================
const GENERATOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Your internal reasoning and thought process for formulating the response',
    },
    response: {
      type: 'string',
      description:
        'The chat message to send to the user. Use Markdown formatting for readability (headers, lists, bold, links, etc).',
    },
  },
  required: ['reasoning', 'response'],
  additionalProperties: false,
};

// ============================================
// Extract partial string content from JSON stream
// Unlike the old regex approach, this can extract content BEFORE the closing quote
// ============================================
function extractPartialStringField(json: string, fieldName: string): string | null {
  // Find the field pattern: "fieldName": "
  const fieldPattern = `"${fieldName}"\\s*:\\s*"`;
  const fieldRegex = new RegExp(fieldPattern);
  const match = json.match(fieldRegex);

  if (!match || match.index === undefined) {
    return null;
  }

  // Start position is right after the opening quote
  const startPos = match.index + match[0].length;

  // Extract everything after the opening quote, handling escape sequences
  let result = '';
  let i = startPos;

  while (i < json.length) {
    const char = json[i];

    if (char === '\\' && i + 1 < json.length) {
      // Handle escape sequences
      const nextChar = json[i + 1];
      switch (nextChar) {
        case '"':
          result += '"';
          break;
        case '\\':
          result += '\\';
          break;
        case 'n':
          result += '\n';
          break;
        case 'r':
          result += '\r';
          break;
        case 't':
          result += '\t';
          break;
        case 'b':
          result += '\b';
          break;
        case 'f':
          result += '\f';
          break;
        default:
          result += nextChar;
          break;
      }
      i += 2;
    } else if (char === '"') {
      // End of string - we got the complete field
      break;
    } else {
      result += char;
      i++;
    }
  }

  return result || null;
}

// ============================================
// Extract streamable text from partial JSON (like agent worker)
// Combines reasoning + response fields as they stream
// ============================================
function extractStreamableText(
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

  // Try to extract the response field
  const response = extractPartialStringField(accumulatedJson, 'response');
  if (response && response.trim()) {
    parts.push(response.trim());
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ============================================
// Generator LLM Call with Streaming
// ============================================
export async function callGeneratorLlm(params: {
  agentId: string;
  messages: ChatMessage[];
  model: string;
  claudeToken: string | null;
  gptToken?: string | null;
  gptAccountId?: string;
  disableWaterfall?: boolean;
}): Promise<GeneratorResponse> {
  const streamId = generateStreamId();

  // Convert messages to OpenAI format (with multimodal support).
  // The system prompt is wrapped in `markCacheable` so the static prefix is
  // explicitly tagged for Anthropic prompt caching at the call-site level.
  // See back-end/src/providers/rose/cache.ts for the helper contract.
  const openaiMessages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | MultimodalContentBlock[];
  }> = [markCacheable(GENERATOR_SYSTEM_PROMPT)];

  for (const msg of params.messages) {
    if (msg.role === 'TOOL') {
      // Skip UI-only lifecycle tools and IN_PROGRESS messages.
      // This matches worker behavior in agents/helpers/llm.py lines 236-238
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

  await broadcastAssistantStream(params.agentId, streamId, '', false, 0, false, false, startTime);

  // Fast Mode: the chat path runs in-process (not through the Python Rose notch),
  // so it caches here. Content-keyed on the conversation so an identical re-ask
  // replays the recorded response. On a hit a one-chunk synthetic stream feeds the
  // existing loop unchanged (still broadcasts + persists). Off → transparent.
  const fastMode = await agentFastMode(params.agentId);
  const fastModeRead = fastMode.enabled === true && fastMode.goal !== null;
  const fastModeWrite = fastMode.writeEnabled === true && fastMode.goal !== null;
  const providerFastMode = fastModeRead || fastModeWrite;
  let fcKey: string | null = null;
  let fcCachedJson: string | null = null;
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
      messages: openaiMessages,
    });
  }
  if (fcKey && fastModeRead) {
    const hit = await cacheGet(fcKey);
    if (hit.hit && hit.value) {
      fcCachedJson = (hit.value as { json?: string }).json ?? null;
      log.info('fast_cache.chat_generator_hit', { agentId: params.agentId, key: fcKey });
    } else {
      log.info('fast_cache.chat_generator_miss', { agentId: params.agentId, key: fcKey });
    }
  } else if (fcKey) {
    log.info('fast_cache.chat_generator_write_only', { agentId: params.agentId, key: fcKey });
  }

  async function* syntheticChatStream(json: string): AsyncGenerator<unknown> {
    yield {
      actual_model: 'fast-cache',
      choices: [{ delta: { content: json }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  // Create streaming completion via Supabase completions endpoint (or replay).
  const stream =
    fcCachedJson !== null
      ? (syntheticChatStream(fcCachedJson) as unknown as Awaited<
          ReturnType<typeof createStreamingCompletion>
        >)
      : await createStreamingCompletion({
          model: params.model,
          messages: openaiMessages,
          temperature: 0.7,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'generator_response',
              strict: true,
              schema: GENERATOR_JSON_SCHEMA,
            },
          },
          claude_token: params.claudeToken ?? undefined,
          gpt_token: params.gptToken ?? undefined,
          gpt_account_id: params.gptAccountId,
          provider_fast_mode: providerFastMode,
          disable_waterfall: params.disableWaterfall,
        });

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
    if (chunk.actual_model) actualModel = chunk.actual_model;
    if (chunk.usage)
      usageData = { ...chunk.usage, finish_reason: chunk.choices[0]?.finish_reason ?? undefined };
    if (!isClaude && actualModel?.endsWith('-claude')) {
      isClaude = true;
    }
    if (!isGpt && actualModel?.endsWith('-gpt')) {
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

    // Extract streamable text (combines reasoning + response fields)
    const streamableText = extractStreamableText(accumulatedReasoning, accumulatedJson);

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

    if (chunk.usage) {
      usage.prompt_tokens = chunk.usage.prompt_tokens ?? 0;
      usage.completion_tokens = chunk.usage.completion_tokens ?? 0;
      usage.total_tokens = chunk.usage.total_tokens ?? 0;
      usage.cache_creation_input_tokens = chunk.usage.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens = chunk.usage.cache_read_input_tokens ?? 0;
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

  // Combine for parsing - use accumulatedJson for JSON parsing
  const fullJson = structuredOutput.finalText();

  // Fast Mode: record the generator response so an identical re-ask replays it.
  if (
    fcKey &&
    fcCachedJson === null &&
    fullJson !== '' &&
    fastMode.goal !== null &&
    fastModeWrite
  ) {
    await cacheSet({
      key: fcKey,
      kind: 'llm',
      goalHash: goalHash(fastMode.goal),
      value: { json: fullJson },
    })
      .then(() =>
        log.info('fast_cache.chat_generator_stored', { agentId: params.agentId, key: fcKey })
      )
      .catch((error) =>
        log.warn('fast_cache.chat_generator_store_failed', {
          agentId: params.agentId,
          key: fcKey,
          error: error instanceof Error ? error.message : String(error),
        })
      );
  }

  // Broadcast final "done" signal
  await broadcastAssistantStream(
    params.agentId,
    streamId,
    '',
    true,
    sequence,
    isClaude,
    isGpt,
    startTime
  );

  const streamDuration = Date.now() - startTime;
  log.info('[GeneratorLLM] Streaming complete', {
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

  // Parse the complete JSON
  if (!fullJson) {
    log.error('[GeneratorLLM] No content received from LLM', {
      agentId: params.agentId,
      streamId,
    });
    throw new Error('Generator LLM returned no content');
  }

  let parsed: { reasoning: string; response: string };
  try {
    parsed = JSON.parse(fullJson);
  } catch (error) {
    log.error('[GeneratorLLM] Failed to parse JSON response', {
      agentId: params.agentId,
      streamId,
      error: error instanceof Error ? error.message : String(error),
      jsonPreview: fullJson.substring(0, 500),
    });
    throw new Error(`Failed to parse generator response as JSON: ${fullJson.substring(0, 200)}`);
  }

  log.info('[GeneratorLLM] Response parsed successfully', {
    agentId: params.agentId,
    streamId,
    totalDurationMs: Date.now() - startTime,
    reasoningLength: parsed.reasoning?.length || 0,
    responseLength: parsed.response?.length || 0,
  });

  return {
    reasoning: parsed.reasoning || '',
    response: parsed.response || '',
    streamId,
    usage,
  };
}
