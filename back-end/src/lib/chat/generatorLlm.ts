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

// ============================================
// Message format for LLM calls
// ============================================
interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
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

  // Convert messages to OpenAI format
  const openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
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
      openaiMessages.push({ role: 'user', content: msg.text });
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
