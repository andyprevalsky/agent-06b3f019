/**
 * Supabase Realtime broadcast utility for chat mode.
 * Broadcasts to agent:{agentId} channel - MUST match exact format from Python worker.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger';

const log = createLogger('Broadcast');

// Use SUPABASE_URL env var, fallback to production URL (matches agent worker behavior)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kzlurqihzaolhzsbkctf.supabase.co';
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
  sequence: number = 0,
  isClaude: boolean = false
): Promise<void> {
  log.info('[Broadcast] ASSISTANT_STREAM', {
    agentId,
    streamId,
    delta: delta.substring(0, 100),
    done,
    sequence,
    isClaude,
  });
  const payload: Record<string, unknown> = {
    agentId: agentId,
    stream_id: streamId, // snake_case to match Python
    delta: delta,
    done: done,
    sequence: sequence,
  };
  payload.is_claude = isClaude;
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'ASSISTANT_STREAM',
    payload,
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
  log.info('[Broadcast] TOOL_STREAM', {
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
      agentId: agentId,
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
  log.info('[Broadcast] AGENT_MODE_STARTED', { agentId });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'AGENT_MODE_STARTED',
    payload: { agentId },
  });
}

/**
 * Broadcast agent UPDATE event - notifies frontend of agent state changes
 * Use this for tree_cost_cents, context_size, and other agent-level updates
 *
 * @param agentId - The agent ID
 * @param updates - Partial agent update data
 */
export async function broadcastAgentUpdate(
  agentId: string,
  updates: {
    treeCostCents?: number;
    contextSize?: number;
    progress?: number;
    status?: string;
    statusMessage?: string;
    tokenCount?: number;
    tokensIn?: number;
    tokensOut?: number;
    messageCount?: number;
  }
): Promise<void> {
  log.info('[Broadcast] UPDATE', { agentId, ...updates });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'UPDATE',
    payload: {
      agentId,
      ...updates,
    },
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
    metadata?: Record<string, unknown>;
    filePointer?: object | null;
  }
): Promise<void> {
  log.info('[Broadcast] INSERT', {
    agentId,
    messageId: message.id,
    role: message.role,
    textLength: message.text.length,
    hasMetadata: Boolean(message.metadata),
  });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'INSERT',
    payload: {
      agentId: agentId,
      id: message.id,
      timestamp: message.timestamp.toISOString(),
      text: message.text,
      role: message.role,
      metadata: message.metadata || null,
      filePointer: message.filePointer || null,
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
async function broadcast(params: { topic: string; event: string; payload: Record<string, unknown> }): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    log.warn('[Broadcast] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
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
            payload: { record: params.payload },
            private: process.env.NODE_ENV === 'production',
          },
        ],
      }),
    });

    if (!response.ok) {
      log.error('Failed', { status: response.status, body: await response.text() });
    }
  } catch (error: unknown) {
    log.error('Error', { err: error instanceof Error ? error.message : String(error) });
  }
}
