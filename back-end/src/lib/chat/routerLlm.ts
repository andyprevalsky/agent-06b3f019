/**
 * Router LLM - First step in chat mode.
 * Analyzes user intent and decides: direct_answer | web_search | agent_start_task
 * Uses Supabase completions endpoint for rose-labs models with streaming.
 */

import { z } from 'zod';
import { createStreamingCompletion } from './supabaseCompletions';
import { ROUTER_SYSTEM_PROMPT } from './chatPrompts';
import {
  broadcastAssistantStream,
  broadcastToolEvent,
  generateStreamId,
} from './supabaseBroadcast';
import { v4 as uuidv4 } from 'uuid';

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
  }),
]);

export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

// ============================================
// Router Response with streaming metadata
// ============================================
export interface RouterResponse {
  decision: RouterDecision;
  streamId: string;
  webSearchToolCallId?: string; // Set if web_search detected during streaming
}

// ============================================
// JSON Schema for OpenAI structured output
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
      description: 'Search query (required if action is web_search)',
    },
    goal: {
      type: 'string',
      description: 'Task goal (required if action is start_superintelligence)',
    },
  },
  required: ['reasoning', 'action'],
  additionalProperties: false,
};

// ============================================
// Message format for LLM calls
// ============================================
interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
}

// ============================================
// Extract reasoning from partial JSON stream
// ============================================
function extractReasoningFromPartialJson(json: string): string | null {
  // Try to extract the reasoning field from partial JSON
  // Match: "reasoning": "..." or "reasoning":"..."
  const match = json.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    try {
      // Unescape JSON string
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
  return null;
}

// ============================================
// Detect action from partial JSON stream
// ============================================
function detectActionFromPartialJson(json: string): string | null {
  const match = json.match(/"action"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

// ============================================
// Router LLM Call with Streaming
// ============================================
export async function callRouterLlm(params: {
  agentId: string;
  messages: ChatMessage[];
  model: string;
}): Promise<RouterResponse> {
  const streamId = generateStreamId();

  // Convert messages to OpenAI format
  const openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
  ];

  for (const msg of params.messages) {
    if (msg.role === 'TOOL') {
      // Skip IN_PROGRESS messages (empty text) - only send FINISHED results to LLM
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
  }

  const startTime = Date.now();
  console.log('[RouterLLM] Starting streaming for routing decision', {
    agentId: params.agentId,
    model: params.model,
    streamId,
    messageCount: openaiMessages.length,
  });

  // Create streaming completion via Supabase completions endpoint
  const stream = await createStreamingCompletion({
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
  });

  let fullJson = '';
  let sequence = 0;
  let lastStreamedReasoning = '';
  let webSearchToolCallId: string | undefined;
  let webSearchDetected = false;

  // Process stream chunks
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) {
      fullJson += delta;

      // Extract reasoning and stream it
      const reasoning = extractReasoningFromPartialJson(fullJson);
      if (reasoning && reasoning.length > lastStreamedReasoning.length) {
        // Stream only the new part of reasoning
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

      // Detect web_search action early and emit TOOL_STREAM IN_PROGRESS
      if (!webSearchDetected) {
        const action = detectActionFromPartialJson(fullJson);
        if (action === 'web_search') {
          webSearchDetected = true;
          webSearchToolCallId = uuidv4();
          console.log('[RouterLLM] Detected web_search early, emitting IN_PROGRESS', {
            toolCallId: webSearchToolCallId,
          });
          await broadcastToolEvent(
            params.agentId,
            streamId,
            webSearchToolCallId,
            'web_search',
            'IN_PROGRESS',
            '🔍 Searching the web'
          );
        }
      }
    }
  }

  // Broadcast final "done" signal for reasoning stream
  await broadcastAssistantStream(
    params.agentId,
    streamId,
    '',
    true,
    sequence
  );

  const streamDuration = Date.now() - startTime;
  console.log('[RouterLLM] Streaming complete', {
    agentId: params.agentId,
    streamId,
    durationMs: streamDuration,
    chunksStreamed: sequence,
    reasoningLength: lastStreamedReasoning.length,
    jsonLength: fullJson.length,
  });

  // Parse the complete JSON
  if (!fullJson) {
    console.error('[RouterLLM] No content received from LLM', {
      agentId: params.agentId,
      streamId,
    });
    throw new Error('Router LLM returned no content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fullJson);
  } catch (error) {
    console.error('[RouterLLM] Failed to parse JSON response', {
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
      decision = { action: 'start_superintelligence', reasoning: raw.reasoning, goal: raw.goal! };
      break;
    default:
      throw new Error(`Unknown action: ${raw.action}`);
  }

  console.log('[RouterLLM] Decision:', {
    action: decision.action,
    reasoning: decision.reasoning.substring(0, 100),
    streamedChunks: sequence,
  });

  return {
    decision,
    streamId,
    webSearchToolCallId,
  };
}
