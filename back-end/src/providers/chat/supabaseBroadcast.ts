/**
 * Supabase Realtime broadcast utility for chat mode.
 * Broadcasts to agent:{agentId} channel - MUST match exact format from Python worker.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger';
import { currentTraceContext } from '../tracing';

const log = createLogger('Broadcast');

// Use SUPABASE_URL env var, fallback to production URL (matches agent worker behavior)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kzlurqihzaolhzsbkctf.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
function finiteEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const BROADCAST_BATCH_SIZE = Math.max(
  1,
  finiteEnvNumber(process.env.SUPABASE_BROADCAST_BATCH_SIZE, 100)
);
const BROADCAST_FLUSH_DELAY_MS = Math.max(
  0,
  Number(process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS || 10)
);
const BROADCAST_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.SUPABASE_BROADCAST_TIMEOUT_MS || 2000)
);

interface QueuedBroadcast {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  private: boolean;
  trace: ReturnType<typeof currentTraceContext>;
  enqueuedAt: number;
}

const broadcastQueue: QueuedBroadcast[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let draining = false;
const idleResolvers: Array<() => void> = [];

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
  isClaude: boolean = false,
  isGpt: boolean = false,
  llmStartedAtMs?: number
): Promise<void> {
  log.info('[Broadcast] ASSISTANT_STREAM', {
    agentId,
    streamId,
    delta: delta.substring(0, 100),
    done,
    sequence,
    isClaude,
    isGpt,
    llmStartedAtMs,
  });
  const payload: Record<string, unknown> = {
    agentId: agentId,
    stream_id: streamId, // snake_case to match Python
    delta: delta,
    done: done,
    sequence: sequence,
  };
  payload.is_claude = isClaude;
  payload.is_gpt = isGpt;
  if (llmStartedAtMs !== undefined) payload.llm_started_at_ms = llmStartedAtMs;
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
  title: string,
  charCount: number = 0,
  isClaude: boolean = false,
  isGpt: boolean = false,
  llmStartedAtMs?: number
): Promise<void> {
  log.info('[Broadcast] TOOL_STREAM', {
    agentId,
    streamId,
    toolCallId,
    toolName,
    status,
    title,
    charCount,
    isClaude,
    isGpt,
    llmStartedAtMs,
  });
  const payload: Record<string, unknown> = {
    agentId: agentId,
    stream_id: streamId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    status: status,
    title: title,
    char_count: charCount,
    is_claude: isClaude,
    is_gpt: isGpt,
  };
  if (llmStartedAtMs !== undefined) payload.llm_started_at_ms = llmStartedAtMs;
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'TOOL_STREAM',
    payload,
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
async function broadcast(params: {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    log.warn('[Broadcast] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return;
  }

  const trace = currentTraceContext();
  broadcastQueue.push({
    ...params,
    private: process.env.NODE_ENV === 'production',
    trace,
    enqueuedAt: Date.now(),
  });

  scheduleBroadcastDrain(
    broadcastQueue.length >= BROADCAST_BATCH_SIZE ? 0 : BROADCAST_FLUSH_DELAY_MS
  );
}

function scheduleBroadcastDrain(delayMs: number): void {
  if (flushTimer !== null) {
    if (delayMs > 0) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void drainBroadcastQueue();
  }, delayMs);
}

async function drainBroadcastQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (broadcastQueue.length > 0) {
      const batch = broadcastQueue.splice(0, BROADCAST_BATCH_SIZE);
      await sendBroadcastBatch(batch);
    }
  } finally {
    draining = false;
    if (broadcastQueue.length > 0) {
      scheduleBroadcastDrain(0);
    } else {
      while (idleResolvers.length > 0) idleResolvers.shift()?.();
    }
  }
}

async function sendBroadcastBatch(batch: QueuedBroadcast[]): Promise<void> {
  if (batch.length === 0) return;

  const url = `${SUPABASE_URL}/realtime/v1/api/broadcast`;
  const serviceRoleKey = SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROADCAST_TIMEOUT_MS);
  const first = batch[0];

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: batch.map((item) => ({
          topic: item.topic,
          event: item.event,
          payload: { record: item.payload },
          private: item.private,
        })),
      }),
      signal: controller.signal,
    });

    log.info('broadcast.span', {
      span_name: 'broadcast',
      parent_span_id: first.trace?.span_id,
      request_id: first.trace?.request_id,
      agent_id: first.trace?.agent_id,
      topic: first.topic,
      event: batch.length === 1 ? first.event : 'BATCH',
      status: response.status,
      duration_ms: Date.now() - started,
      batch_size: batch.length,
      max_queue_delay_ms: Math.max(...batch.map((item) => started - item.enqueuedAt)),
    });

    if (!response.ok) {
      log.error('Failed', { status: response.status, body: await response.text() });
    }
  } catch (error: unknown) {
    log.info('broadcast.span', {
      span_name: 'broadcast',
      parent_span_id: first.trace?.span_id,
      request_id: first.trace?.request_id,
      agent_id: first.trace?.agent_id,
      topic: first.topic,
      event: batch.length === 1 ? first.event : 'BATCH',
      status: 'error',
      duration_ms: Date.now() - started,
      batch_size: batch.length,
      max_queue_delay_ms: Math.max(...batch.map((item) => started - item.enqueuedAt)),
    });
    log.error('Error', { err: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timeout);
  }
}

export async function __flushBroadcastQueueForTests(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await drainBroadcastQueue();
  if (!draining && broadcastQueue.length === 0) return;
  await new Promise<void>((resolve) => idleResolvers.push(resolve));
}
