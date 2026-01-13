/**
 * Generator LLM - Second step in chat mode.
 * Generates the user-facing response with streaming support.
 * Uses Supabase completions endpoint for rose-labs models.
 * Uses structured output with separate reasoning (thinking) and response (true message) fields.
 */

import { createStreamingCompletion } from './supabaseCompletions';
import { GENERATOR_SYSTEM_PROMPT } from './chatPrompts';
import {
  broadcastAssistantStream,
  generateStreamId,
} from './supabaseBroadcast';
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

// ============================================
// Message format for LLM calls
// ============================================
interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  filePointer?: any; // FilePointer from DB JSON - validated at runtime
  metadata?: Record<string, any>;
}

// File size threshold for inline content (20MB)
const LLM_INLINE_THRESHOLD = 20 * 1024 * 1024;

// File type helpers
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/json', 'application/xml']);

// ============================================
// Build multimodal content from a file pointer
// Downloads from storage and converts to base64 for LLM
// ============================================
async function buildMultimodalContentFromFile(
  text: string,
  filePointer: FilePointer
): Promise<Array<{ type: string; text?: string; image_url?: { url: string } }>> {
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  // File too large for inline content
  if (filePointer.size_bytes >= LLM_INLINE_THRESHOLD) {
    const sizeStr = (filePointer.size_bytes / 1024 / 1024).toFixed(1);
    content.push({
      type: 'text',
      text: text ? `${text}\n\n[Attached: ${filePointer.original_filename} (${sizeStr}MB) - too large for inline viewing]` : `[Attached: ${filePointer.original_filename} (${sizeStr}MB) - too large for inline viewing]`
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
          url: `data:${filePointer.mime_type};base64,${base64}`
        }
      });
    } else if (TEXT_MIME_TYPES.has(filePointer.mime_type) || filePointer.mime_type.startsWith('text/')) {
      // Text file: decode and add as text
      const decoded = fileBuffer.toString('utf-8');
      content.push({
        type: 'text',
        text: text ? `${text}\n\n[File: ${filePointer.original_filename}]\n\`\`\`\n${decoded}\n\`\`\`` : `[File: ${filePointer.original_filename}]\n\`\`\`\n${decoded}\n\`\`\``
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
          file_data: `data:${filePointer.mime_type};base64,${base64}`
        }
      } as any);
    } else {
      // Other file types: just metadata
      content.push({
        type: 'text',
        text: text ? `${text}\n\n[Attached: ${filePointer.original_filename} (${filePointer.mime_type})]` : `[Attached: ${filePointer.original_filename} (${filePointer.mime_type})]`
      });
    }
  } catch (error) {
    console.error('[GeneratorLLM] Failed to download file from storage:', error);
    content.push({
      type: 'text',
      text: text ? `${text}\n\n[Attached: ${filePointer.original_filename} - failed to load]` : `[Attached: ${filePointer.original_filename} - failed to load]`
    });
  }

  return content;
}

// ============================================
// Generator Response
// ============================================
export interface GeneratorResponse {
  reasoning: string;  // Streamed as thinking (ASSISTANT_STREAM)
  response: string;   // Saved as ASSISTANT message (INSERT)
  streamId: string;
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
      description: 'The chat message to send to the user. Use Markdown formatting for readability (headers, lists, bold, links, etc).',
    },
  },
  required: ['reasoning', 'response'],
  additionalProperties: false,
};

// ============================================
// Extract reasoning from partial JSON stream
// ============================================
function extractReasoningFromPartialJson(json: string): string | null {
  const match = json.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
  return null;
}

// ============================================
// Generator LLM Call with Streaming
// ============================================
export async function callGeneratorLlm(params: {
  agentId: string;
  messages: ChatMessage[];
  model: string;
}): Promise<GeneratorResponse> {
  const streamId = generateStreamId();

  // Convert messages to OpenAI format (with multimodal support)
  const openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [
    { role: 'system', content: GENERATOR_SYSTEM_PROMPT },
  ];

  for (const msg of params.messages) {
    if (msg.role === 'TOOL') {
      // Skip IN_PROGRESS messages (empty text) - only send FINISHED results to LLM
      // This matches worker behavior in agents/helpers/llm.py lines 236-238
      if (!msg.text || msg.text.trim() === '') {
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
        // Build multimodal content from file (downloads from storage)
        const content = await buildMultimodalContentFromFile(msg.text, msg.filePointer);
        openaiMessages.push({
          role: 'user',
          content,
        });
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
  console.log('[GeneratorLLM] Starting streaming response', {
    agentId: params.agentId,
    model: params.model,
    streamId,
    messageCount: openaiMessages.length,
  });

  // Log full context being sent to generator (no truncation)
  console.log('[GeneratorLLM] Context being sent to LLM:');
  openaiMessages.forEach((msg, i) => {
    console.log(`[GeneratorLLM] Message ${i}: role=${msg.role}, content=${msg.content}`);
  });

  // Create streaming completion via Supabase completions endpoint
  const stream = await createStreamingCompletion({
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
  });

  let fullJson = '';
  let sequence = 0;
  let lastStreamedReasoning = '';

  // Process stream chunks - only stream the reasoning field
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) {
      fullJson += delta;

      // Extract and stream reasoning
      const reasoning = extractReasoningFromPartialJson(fullJson);
      if (reasoning && reasoning.length > lastStreamedReasoning.length) {
        const newReasoning = reasoning.slice(lastStreamedReasoning.length);
        if (newReasoning) {
          await broadcastAssistantStream(
            params.agentId,
            streamId,
            newReasoning,
            false,
            sequence++
          );
          lastStreamedReasoning = reasoning;
        }
      }
    }
  }

  // Broadcast final "done" signal
  await broadcastAssistantStream(
    params.agentId,
    streamId,
    '',
    true,
    sequence
  );

  const streamDuration = Date.now() - startTime;
  console.log('[GeneratorLLM] Streaming complete', {
    agentId: params.agentId,
    streamId,
    durationMs: streamDuration,
    chunksStreamed: sequence,
    reasoningLength: lastStreamedReasoning.length,
    jsonLength: fullJson.length,
  });

  // Parse the complete JSON
  if (!fullJson) {
    console.error('[GeneratorLLM] No content received from LLM', {
      agentId: params.agentId,
      streamId,
    });
    throw new Error('Generator LLM returned no content');
  }

  let parsed: { reasoning: string; response: string };
  try {
    parsed = JSON.parse(fullJson);
  } catch (error) {
    console.error('[GeneratorLLM] Failed to parse JSON response', {
      agentId: params.agentId,
      streamId,
      error: error instanceof Error ? error.message : String(error),
      jsonPreview: fullJson.substring(0, 500),
    });
    throw new Error(`Failed to parse generator response as JSON: ${fullJson.substring(0, 200)}`);
  }

  console.log('[GeneratorLLM] Response parsed successfully', {
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
  };
}
