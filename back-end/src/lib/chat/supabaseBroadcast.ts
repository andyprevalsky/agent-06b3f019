/**
 * Supabase Realtime broadcast utility for chat mode.
 * Broadcasts to agent:{agentId} channel - MUST match exact format from Python worker.
 */

import { v4 as uuidv4 } from 'uuid';

// Use local Supabase in development, production URL otherwise
const SUPABASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://kzlurqihzaolhzsbkctf.supabase.co'
  : 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Stream assistant response chunks - EXACT same format as Python worker
 *
 * @param agentId - The agent ID to broadcast to
 * @param streamId - Unique ID for this streaming session
 * @param delta - The NEW text chunk (not accumulated)
 * @param done - Whether streaming is complete
 * @param sequence - Sequence number for ordering
 */
export async function broadcastAssistantStream(
  agentId: string,
  streamId: string,
  delta: string,
  done: boolean = false,
  sequence: number = 0
): Promise<void> {
  console.log('[Broadcast] ASSISTANT_STREAM', {
    agentId,
    streamId,
    delta: delta.substring(0, 100),
    done,
    sequence,
  });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'ASSISTANT_STREAM',
    payload: {
      stream_id: streamId,  // snake_case to match Python
      delta: delta,
      done: done,
      sequence: sequence,
    },
  });
}

/**
 * Broadcast tool execution status - matches TOOL_STREAM from Python
 *
 * @param agentId - The agent ID to broadcast to
 * @param streamId - Unique ID for this streaming session
 * @param toolCallId - Unique ID for this tool call
 * @param toolName - Name of the tool being executed
 * @param status - Current status of the tool execution
 * @param title - Display title for the tool (e.g., "🔍 Searching the web")
 */
export async function broadcastToolEvent(
  agentId: string,
  streamId: string,
  toolCallId: string,
  toolName: string,
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR',
  title: string
): Promise<void> {
  console.log('[Broadcast] TOOL_STREAM', {
    agentId,
    streamId,
    toolCallId,
    toolName,
    status,
    title,
  });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'TOOL_STREAM',
    payload: {
      stream_id: streamId,
      tool_call_id: toolCallId,
      tool_name: toolName,
      status: status,
      title: title,
    },
  });
}

/**
 * Broadcast when chat escalates to agent mode
 */
export async function broadcastAgentModeStarted(agentId: string): Promise<void> {
  console.log('[Broadcast] AGENT_MODE_STARTED', { agentId });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'AGENT_MODE_STARTED',
    payload: { agentId },
  });
}

/**
 * Broadcast message INSERT event - notifies frontend of new message
 * This is the "true message" that shows in the chat (clears thinking bubble)
 *
 * @param agentId - The agent ID
 * @param message - The message data (matches frontend Message type)
 */
export async function broadcastMessageInsert(
  agentId: string,
  message: {
    id: string;
    timestamp: Date;
    text: string;
    role: string;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  console.log('[Broadcast] INSERT', {
    agentId,
    messageId: message.id,
    role: message.role,
    text: message.text,
    metadata: message.metadata,
  });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'INSERT',
    payload: {
      id: message.id,
      timestamp: message.timestamp.toISOString(),
      text: message.text,
      role: message.role,
      metadata: message.metadata || null,
    },
  });
}

/**
 * Generate a unique stream ID for a streaming session
 */
export function generateStreamId(): string {
  return uuidv4();
}

/**
 * Core broadcast function - sends to Supabase Realtime
 */
async function broadcast(params: {
  topic: string;
  event: string;
  payload: any;
}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[Broadcast] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return;
  }

  const url = `${SUPABASE_URL}/realtime/v1/api/broadcast`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            topic: params.topic,
            event: params.event,
            payload: { record: params.payload },  // Nested in 'record' like Python
            private: true,  // Required for private channels
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error('[Broadcast] Failed:', response.status, await response.text());
    }
  } catch (error) {
    console.error('[Broadcast] Error:', error);
  }
}
