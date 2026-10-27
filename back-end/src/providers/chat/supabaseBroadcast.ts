/**
 * Supabase Realtime broadcast utility for chat mode.
 * Broadcasts to agent:{agentId} channel - MUST match exact format from Python worker.
 *
 * Assistant stream lifecycle / system context:
 *
 *   Router/Generator STARTED (seq 0) -> normal batch timer
 *                         first DELTA (seq 1) -> cancel timer + immediate FIFO drain
 *                         later DELTAS / DONE -> normal batch timer
 *   Router DONE + clear_on_done -> frontend removes bubble
 *   Generator RESPONSE -> ATTENTION_STREAM accumulated frames -> keyed TOOL INSERT
 *   Python worker stream payloads -> unchanged; drain priority is never serialized
 *   Committed INSERT refused with a non-retryable 4xx (e.g. edge WAF 403)
 *     -> INSERT_ENCODED (same record, base64 content) -> INSERT_DEFERRED
 *        (ids + tool lifecycle + visible reason; client reads the row by id)
 *   Committed INSERT larger than LIVE_INSERT_MAX_BYTES (8 KB) -> INSERT_DEFERRED
 *        with a text preview and the small metadata (largest keys dropped until it
 *        fits); the client shows the preview, then reads the row by id
 *   INSERT_DEFERRED refused -> INSERT_DEFERRED without preview (blocked reason)
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger';
import { currentTraceContext } from '../tracing';
import { projectMessageBroadcastMetadata } from './messageBroadcastProjection';
import {
  CommittedMessageDelivery,
  InitialBroadcastDispatcher,
  MAX_COMMITTED_QUEUE_AGE_MS,
  type BroadcastOutcome,
} from './committedMessageDelivery';

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
  Math.min(100, Math.floor(finiteEnvNumber(process.env.SUPABASE_BROADCAST_BATCH_SIZE, 100)))
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
  committedCohort?: {
    enqueuedAt: number;
    settle: (outcome: BroadcastOutcome) => Promise<void>;
  };
}

const initialDispatcher = new InitialBroadcastDispatcher<QueuedBroadcast>();
let flushTimer: NodeJS.Timeout | null = null;
const inFlightBatches = new Set<Promise<void>>();
const MAX_IN_FLIGHT_BATCHES = 64;
const committedDelivery = new CommittedMessageDelivery<QueuedBroadcast>(
  (items, enqueuedAt, settle) => {
    const committedCohort = { enqueuedAt, settle };
    if (!initialDispatcher.enqueueGroup(items.map((item) => ({ ...item, committedCohort })))) {
      void settle({ ok: false, retryable: false, status: 'error' });
      return;
    }
    scheduleBroadcastDrain(BROADCAST_FLUSH_DELAY_MS);
  },
  (items) => sendBroadcastBatch(items),
  BROADCAST_BATCH_SIZE,
  (topic) => initialDispatcher.admissionBudget(topic),
  [
    { name: 'INSERT_ENCODED', map: encodedInsert },
    { name: 'INSERT_DEFERRED', map: (item) => deferredInsert(item, BLOCKED_STREAM_REASON) },
  ],
  (item) => deferredInsert(item, OVERSIZE_STREAM_REASON)
);

/** Shown in place of a row whose live frame was refused, until the client reads it. */
export const BLOCKED_STREAM_REASON =
  'This message contained content that was blocked from live streaming to the app.';
export const OVERSIZE_STREAM_REASON =
  'This message is too large to stream live; loading it from the server.';

/**
 * Largest committed INSERT frame sent live. Supabase Realtime caps a project at
 * 1 MB/s; rows above 8 KB are 5.7% of messages but 58% of INSERT bytes
 * (prod, 7 days to 2026-10-27), so they stream as bounded notices instead.
 */
export const LIVE_INSERT_MAX_BYTES = Math.max(
  1024,
  Math.floor(finiteEnvNumber(process.env.SUPABASE_BROADCAST_LIVE_INSERT_MAX_BYTES, 8 * 1024))
);
/** Characters of `text` a bounded notice previews before the client hydrates. */
export const LIVE_INSERT_PREVIEW_CHARS = 1000;
/** Longest lifecycle string a content-free notice repeats. */
const LIFECYCLE_VALUE_MAX_CHARS = 256;
/** Control fields every bounded notice keeps (each fits its own notice). */
const LIFECYCLE_METADATA_KEYS = new Set(['toolName', 'toolStatus', 'toolCallId', 'success']);

/** Bytes of the exact message `sendBroadcastBatch` puts on the wire for this item. */
const wireBytes = (
  item: Pick<QueuedBroadcast, 'topic' | 'event' | 'payload' | 'private'>
): number =>
  Buffer.byteLength(
    JSON.stringify({
      topic: item.topic,
      event: item.event,
      payload: { record: item.payload },
      private: item.private,
    })
  );

/**
 * A committed row too large to stream live: ids, a text preview, filePointer and
 * the metadata that fits, dropping the largest non-lifecycle keys first. The
 * frame never carries `text`, so every client treats it as a notice to hydrate.
 * If it still exceeds the cap with an empty preview (a huge filePointer or
 * lifecycle string), the minimal content-free notice is sent instead.
 */
function boundedInsert(item: QueuedBroadcast): QueuedBroadcast {
  const { agentId, id, timestamp, role, text, metadata, filePointer } = item.payload;
  const kept: Record<string, unknown> = { ...((metadata ?? {}) as Record<string, unknown>) };
  let preview = typeof text === 'string' ? text.slice(0, LIVE_INSERT_PREVIEW_CHARS) : '';
  const build = (): Record<string, unknown> => ({
    agentId,
    id,
    timestamp,
    role,
    reason: OVERSIZE_STREAM_REASON,
    preview,
    metadata: kept,
    filePointer: filePointer ?? null,
  });
  const fits = () =>
    wireBytes({ ...item, event: 'INSERT_DEFERRED', payload: build() }) <= LIVE_INSERT_MAX_BYTES;
  const droppable = Object.keys(kept)
    .filter((key) => !LIFECYCLE_METADATA_KEYS.has(key))
    .sort((a, b) => JSON.stringify(kept[b]).length - JSON.stringify(kept[a]).length);
  for (const key of droppable) {
    if (fits()) break;
    delete kept[key];
  }
  while (preview.length > 0 && !fits()) {
    preview = preview.slice(0, Math.floor(preview.length / 2));
  }
  if (!fits()) return deferredInsert(item, OVERSIZE_STREAM_REASON);
  return { ...item, event: 'INSERT_DEFERRED', payload: build() };
}

/** The identical record with its content fields as one base64 JSON blob. */
function encodedInsert(item: QueuedBroadcast): QueuedBroadcast {
  // A refused bounded notice has no full record to re-encode; drop its preview.
  if (item.event === 'INSERT_DEFERRED') return deferredInsert(item, BLOCKED_STREAM_REASON);
  const { agentId, id, timestamp, role, text, metadata, filePointer } = item.payload;
  const data = Buffer.from(JSON.stringify({ text, metadata, filePointer }), 'utf8');
  return {
    ...item,
    event: 'INSERT_ENCODED',
    payload: { agentId, id, timestamp, role, encoding: 'base64', data: data.toString('base64') },
  };
}

/** Identifiers, tool lifecycle scalars and a visible reason; no row content. */
function deferredInsert(item: QueuedBroadcast, reason: string): QueuedBroadcast {
  const { agentId, id, timestamp, role, metadata } = item.payload;
  const source = (metadata ?? {}) as Record<string, unknown>;
  const lifecycle: Record<string, unknown> = {};
  for (const key of ['toolName', 'toolStatus', 'toolCallId']) {
    // Bounded so a notice always fits both the live cap and the agent lane.
    if (typeof source[key] === 'string')
      lifecycle[key] = source[key].slice(0, LIFECYCLE_VALUE_MAX_CHARS);
  }
  if (typeof source.success === 'boolean') lifecycle.success = source.success;
  return {
    ...item,
    event: 'INSERT_DEFERRED',
    payload: { agentId, id, timestamp, role, reason, metadata: lifecycle },
  };
}

interface AssistantStreamOptions {
  /** Remove a purely ephemeral stream at its terminal event. */
  clearOnDone?: boolean;
}

interface BroadcastOptions {
  /** Bypass the batch delay without changing the queued event's wire shape. */
  immediateDrain?: boolean;
}

/**
 * Stream assistant response chunks - EXACT same format as Python worker
 *
 * @param agentId - The agent ID to broadcast to
 * @param streamId - Unique ID for this streaming session
 * @param delta - The NEW text chunk (not accumulated)
 * @param done - Whether streaming is complete
 * @param sequence - Sequence number for ordering
 * @param options - Optional lifecycle metadata for phase-specific streams
 */
export async function broadcastAssistantStream(
  agentId: string,
  streamId: string,
  delta: string,
  done: boolean = false,
  sequence: number = 0,
  isClaude: boolean = false,
  isGpt: boolean = false,
  llmStartedAtMs?: number,
  options?: AssistantStreamOptions
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
    clearOnDone: done ? options?.clearOnDone : undefined,
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
  if (done && options?.clearOnDone !== undefined) {
    payload.clear_on_done = options.clearOnDone;
  }
  await broadcast(
    {
      topic: `agent:${agentId}`,
      event: 'ASSISTANT_STREAM',
      payload,
    },
    { immediateDrain: delta.length > 0 && !done && sequence === 1 }
  );
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

export async function broadcastAttentionStream(
  agentId: string,
  event: {
    streamId: string;
    toolCallId: string;
    message: string;
    done: boolean;
    sequence: number;
  }
): Promise<void> {
  await broadcast(
    {
      topic: `agent:${agentId}`,
      event: 'ATTENTION_STREAM',
      payload: {
        agentId,
        stream_id: event.streamId,
        tool_call_id: event.toolCallId,
        message: event.message,
        is_question: false,
        done: event.done,
        sequence: event.sequence,
      },
    },
    {
      immediateDrain: event.message.length > 0 && !event.done && event.sequence === 1,
    }
  );
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
 * USER_UI_ACTIVE_CHANGED — a code agent published (and activated) a new
 * rose_user_ui version. Sent on the publishing agent's channel and its root's
 * so an open Rose tab refetches /api/user-ui/active without a reload.
 */
export async function broadcastUserUiActiveChanged(
  agentIds: string[],
  payload: { versionId: string; agentId: string }
): Promise<void> {
  log.info('[Broadcast] USER_UI_ACTIVE_CHANGED', { ...payload, channels: agentIds.length });
  await Promise.all(
    agentIds.map((id) =>
      broadcast({ topic: `agent:${id}`, event: 'USER_UI_ACTIVE_CHANGED', payload })
    )
  );
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
    title?: string | null;
    treeCostCents?: number;
    contextSize?: number;
    progress?: number;
    progressEstimate?: import('../../utils/progressEstimate').ProgressEstimate | null;
    taskProgressEstimates?: Record<string, import('../../utils/progressEstimate').ProgressEstimate>;
    status?: string;
    statusMessage?: string;
    tokenCount?: number;
    tokensIn?: number;
    tokensOut?: number;
    messageCount?: number;
    temporalWorkflowId?: string | null;
    updatedAt?: string;
  },
  busId?: string
): Promise<void> {
  log.info('[Broadcast] UPDATE', { agentId, ...updates });
  const payload = { agentId, ...updates };
  // Reuse the batched realtime transport and existing tree subscription. No per-row channels.
  await Promise.all([
    broadcast({ topic: `agent:${agentId}`, event: 'UPDATE', payload }),
    ...(busId ? [broadcast({ topic: `bus:${busId}`, event: 'UPDATE', payload })] : []),
  ]);
}

/**
 * Broadcast BROWSER_SESSION - the provider session a browser task is bound to.
 *
 * Sent whenever a task's BrowserSession row is rebound (challenge recovery,
 * resume, rotation, reclaim) or closed, before the old provider session is
 * released, so the live view never keeps embedding a released session while
 * the worker has not yet posted the new URL. `asOf` orders events against the
 * live-view GET: consumers keep the newest observation per task, so callers
 * pass the time captured before they read the row.
 */
export async function broadcastBrowserSessionBinding(
  agentId: string,
  binding: { taskId: string; sessionId: string; debugUrl: string | null; status: string },
  asOf: number
): Promise<void> {
  log.info('[Broadcast] BROWSER_SESSION', {
    agentId,
    taskId: binding.taskId,
    sessionId: binding.sessionId,
    status: binding.status,
  });
  await broadcast({
    topic: `agent:${agentId}`,
    event: 'BROWSER_SESSION',
    payload: {
      agentId,
      ...binding,
      live: binding.status === 'ACTIVE',
      asOf,
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
      metadata: projectMessageBroadcastMetadata(message.role, message.metadata) || null,
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
async function broadcast(
  params: {
    topic: string;
    event: string;
    payload: Record<string, unknown>;
  },
  options: BroadcastOptions = {}
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    log.warn('[Broadcast] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return;
  }

  const trace = currentTraceContext();
  const item: QueuedBroadcast = {
    ...params,
    private: process.env.NODE_ENV === 'production',
    trace,
    enqueuedAt: Date.now(),
  };
  if (params.event === 'INSERT') {
    // Freeze caller-owned metadata so an uncertain send retries identical bytes.
    const serialized = JSON.stringify(item.payload);
    item.payload = JSON.parse(serialized) as Record<string, unknown>;
    const bytes = Buffer.byteLength(serialized) + Buffer.byteLength(item.topic);
    if (wireBytes(item) <= LIVE_INSERT_MAX_BYTES) {
      committedDelivery.enqueue(item, bytes);
      return;
    }
    const bounded = boundedInsert(item);
    const boundedBytes =
      Buffer.byteLength(JSON.stringify(bounded.payload)) + Buffer.byteLength(bounded.topic);
    log.info('[Broadcast] INSERT bounded to a live notice', {
      topic: item.topic,
      message_id: item.payload.id,
      bytes,
      bounded_bytes: boundedBytes,
    });
    committedDelivery.enqueue(bounded, boundedBytes);
    return;
  }
  if (!initialDispatcher.enqueue(item)) return;

  scheduleBroadcastDrain(options.immediateDrain ? 0 : BROADCAST_FLUSH_DELAY_MS);
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
  while (initialDispatcher.hasReady() && inFlightBatches.size < MAX_IN_FLIGHT_BATCHES) {
    const lease = initialDispatcher.takeBatch(BROADCAST_BATCH_SIZE);
    const batch = lease.items;
    // Network waits are independent. One agent's retry cannot hold the drain.
    const eligibilityAt = Date.now();
    const active = batch.filter(
      (item) =>
        item.committedCohort === undefined ||
        eligibilityAt - item.committedCohort.enqueuedAt < MAX_COMMITTED_QUEUE_AGE_MS
    );
    const task = sendBroadcastBatch(active)
      .then((outcome) => {
        lease.release();
        const activeItems = new Set(active);
        const settled = new Set<QueuedBroadcast['committedCohort']>();
        for (const item of batch) {
          const cohort = item.committedCohort;
          if (cohort === undefined || settled.has(cohort)) continue;
          settled.add(cohort);
          void cohort.settle(
            activeItems.has(item) ? outcome : { ok: false, retryable: false, status: 'error' }
          );
        }
      })
      .finally(() => {
        inFlightBatches.delete(task);
        if (initialDispatcher.hasReady()) scheduleBroadcastDrain(0);
      });
    inFlightBatches.add(task);
  }
}

async function sendBroadcastBatch(batch: QueuedBroadcast[]): Promise<BroadcastOutcome> {
  if (batch.length === 0) return { ok: true, retryable: false, status: 202 };

  const url = `${SUPABASE_URL}/realtime/v1/api/broadcast`;
  const serviceRoleKey = SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return { ok: false, retryable: false, status: 'error' };
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
    return {
      ok: response.ok,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      status: response.status,
    };
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
    return { ok: false, retryable: true, status: 'error' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function __flushBroadcastQueueForTests(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  do {
    await drainBroadcastQueue();
    await Promise.all(inFlightBatches);
    await committedDelivery.waitForSettlements();
  } while (initialDispatcher.hasReady() || inFlightBatches.size > 0);
}
