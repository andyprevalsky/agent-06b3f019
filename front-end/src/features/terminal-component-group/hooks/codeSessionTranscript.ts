/**
 * A code session's structured transcript, folded from the owner's message rows
 * (both providers, one shape: agents/utils/code_transcript.py `to_ui_record`).
 *
 *   TOOL row action_type 'code_transcript' (task-scoped, batched)
 *     metadata.code_agent_events[] = {id, rev, seq, provider, ts, type:
 *       'thinking'|'message'|'tool'|'result'|'error'|'control', text?, role?,
 *       sender?, turn_id?, tool?{name, target, category?, added?, removed?,
 *       result?: string | {status, exit_code?, output?}}, status?, …}
 *
 * Records are UPSERTS: the same `id` is re-sent with a higher `rev` as it
 * streams or completes (a tool row: running → ok/error). Folding keeps the
 * latest rev per id, ordered by `seq` (the creating event's index), so a row
 * keeps its key and position from streaming to final and a replay/reconnect
 * that resends records adds nothing. Rows without ids (older producers) key
 * by carrier message + index.
 *
 * Turn lifecycle (optional, forward-compatible): `turn_id` on any record;
 * `turn_started_at` / `turn_ended_at` / `outcome` ('completed'|'interrupted'|
 * 'failed') on the record that ends a turn. Absent → derived (codeSessionTurns).
 */

import type { Message } from '@/lib/api/types';

import {
  eventTimeMs,
  parseAgentToAgentMessage,
  type CodeAgentProvider,
  type CodeAgentToolCall,
  type CodeAgentTranscriptEvent,
} from './codeAgentContract';

export type TranscriptType =
  'thinking' | 'message' | 'tool' | 'result' | 'error' | 'control' | 'turn' | 'metrics';
export type ToolCategory = 'read' | 'edit' | 'run' | 'search' | 'other';
export type TurnOutcome = 'completed' | 'interrupted' | 'failed';

export interface TranscriptTool extends CodeAgentToolCall {
  category: ToolCategory;
  /** running | ok | error (from the result object or `ok`). */
  status: 'running' | 'ok' | 'error' | null;
  /** Output preview (the tail a user scans), when the record carries one. */
  output?: string;
}

export interface TranscriptEntry {
  /** Stable within the session: the record id (or carrier + index). */
  key: string;
  rev: number;
  seq: number | null;
  /** First-seen order (tie-break for records without seq). */
  order: number;
  type: TranscriptType;
  event?: string;
  clientMessageId?: string;
  partial?: boolean;
  outputTokens?: number;
  usageScope?: 'turn' | 'session';
  /** Latest contributing event (ms); null when unknown. */
  at: number | null;
  /** The carrier row's time (ms) when the record was first seen. */
  firstSeenAt: number | null;
  text: string;
  role: 'assistant' | 'user';
  /** user records: 'user' (the person) or 'agent' (Rose's goal / instructions). */
  sender: 'user' | 'agent';
  turnId: string | null;
  tool?: TranscriptTool;
  /** result rows: completed | failed. */
  status?: string;
  outcome?: TurnOutcome;
  turnStartedAt?: number | null;
  turnEndedAt?: number | null;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const TYPES: readonly TranscriptType[] = [
  'thinking',
  'message',
  'tool',
  'result',
  'error',
  'control',
  'turn',
  'metrics',
];
const OUTCOMES: readonly TurnOutcome[] = ['completed', 'interrupted', 'failed'];

function toolCategory(category: unknown, name: string): ToolCategory {
  if (
    category === 'read' ||
    category === 'edit' ||
    category === 'run' ||
    category === 'search' ||
    category === 'other'
  ) {
    return category;
  }
  if (/^(read|notebookread)$/i.test(name)) return 'read';
  if (/^(edit|multiedit|write|notebookedit|file_change)$/i.test(name)) return 'edit';
  if (/^(run|bash|bashoutput|command)$/i.test(name)) return 'run';
  if (/^(grep|glob|ls|search|websearch|webfetch|toolsearch)$/i.test(name)) return 'search';
  return 'other';
}

/** `tool.result` is a string (older UI shape) or {status, exit_code, …} (to_ui_record). */
function toolResult(raw: Rec): Pick<TranscriptTool, 'result' | 'ok' | 'status' | 'output'> {
  const result = raw.result;
  const ok = typeof raw.ok === 'boolean' ? raw.ok : undefined;
  if (typeof result === 'string') {
    return { result: str(result), ok, status: ok === false ? 'error' : ok ? 'ok' : null };
  }
  const r = rec(result);
  const status =
    r?.status === 'running' || r?.status === 'ok' || r?.status === 'error' ? r.status : null;
  const exit = num(r?.exit_code);
  const text =
    status === 'error'
      ? exit !== undefined
        ? `✗ exit ${exit}`
        : '✗'
      : status === 'ok' && exit !== undefined
        ? '✓'
        : undefined;
  return {
    result: text,
    ok: status === 'ok' ? true : status === 'error' ? false : ok,
    status,
    output: str(r?.output),
  };
}

function parseTool(value: unknown): TranscriptTool | undefined {
  const r = rec(value);
  const name = str(r?.name);
  if (!r || !name) return undefined;
  return {
    name,
    target: typeof r.target === 'string' ? r.target : '',
    added: num(r.added),
    removed: num(r.removed),
    category: toolCategory(
      r.activity_kind === 'exec' ? 'run' : (r.activity_kind ?? r.category),
      name,
    ),
    ...toolResult(r),
  };
}

function parseRecord(
  value: unknown,
  fallbackKey: string,
  carrierAt: number | null,
  order: number,
): TranscriptEntry | null {
  const r = rec(value);
  const type = TYPES.find((t) => t === r?.type);
  if (!r || !type) return null;
  const tool = type === 'tool' ? parseTool(r.tool) : undefined;
  if (type === 'tool' && !tool) return null;
  const text = typeof r.text === 'string' ? r.text : '';
  if ((type === 'message' || type === 'thinking') && !text && r.redacted !== true) return null;
  const outcome = OUTCOMES.find((o) => o === (r.turn_outcome ?? r.outcome));
  return {
    key: str(r.id) ?? fallbackKey,
    rev: num(r.rev) ?? 1,
    seq: num(r.seq) ?? null,
    order,
    type,
    event: str(r.event),
    clientMessageId: str(r.client_message_id),
    partial: typeof r.partial === 'boolean' ? r.partial : undefined,
    outputTokens:
      num(r.output_tokens) !== undefined && Number(r.output_tokens) >= 0
        ? num(r.output_tokens)
        : undefined,
    usageScope: r.usage_scope === 'turn' || r.usage_scope === 'session' ? r.usage_scope : undefined,
    at: eventTimeMs(r.ts as string | number | undefined),
    firstSeenAt: carrierAt,
    text,
    role: r.role === 'user' ? 'user' : 'assistant',
    sender: r.sender === 'agent' ? 'agent' : 'user',
    turnId: str(r.turn_id) ?? null,
    tool,
    status: str(r.status),
    outcome,
    turnStartedAt: eventTimeMs(r.turn_started_at as string | number | undefined),
    turnEndedAt: eventTimeMs(r.turn_ended_at as string | number | undefined),
  };
}

function compareEntries(a: TranscriptEntry, b: TranscriptEntry): number {
  if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq;
  if (a.seq === null || b.seq === null) {
    const at = a.at ?? a.firstSeenAt ?? 0;
    const bt = b.at ?? b.firstSeenAt ?? 0;
    if (at !== bt) return at - bt;
  }
  return a.order - b.order;
}

/**
 * The session's transcript records, latest rev per id, in creation order.
 * Every carrier row of this task contributes (any action type), so batches,
 * realtime INSERTs and replays fold into one list without duplicates.
 */
export function foldSessionTranscript(messages: Message[], taskId: string): TranscriptEntry[] {
  const byKey = new Map<string, TranscriptEntry>();
  let order = 0;
  for (const message of messages) {
    const metadata = message.metadata;
    if (!metadata || metadata.task_id !== taskId) continue;
    const raw = metadata.code_agent_events;
    if (!Array.isArray(raw)) continue;
    const carrierAt = eventTimeMs(message.timestamp);
    raw.forEach((value, index) => {
      const entry = parseRecord(value, `${message.message_id}#${index}`, carrierAt, order);
      order += 1;
      if (!entry) return;
      const existing = byKey.get(entry.key);
      if (!existing) {
        byKey.set(entry.key, entry);
        return;
      }
      if (entry.rev < existing.rev) return;
      // Same id, newer (or equal: later delivery) rev: keep its first position and sighting.
      byKey.set(entry.key, {
        ...entry,
        order: existing.order,
        seq: entry.seq ?? existing.seq,
        firstSeenAt: existing.firstSeenAt ?? entry.firstSeenAt,
      });
    });
  }
  return [...byKey.values()].sort(compareEntries);
}

/**
 * The chip's Transcript tab events (thinking / message / tool / agent_message),
 * folded like the view: one row per record id, latest rev.
 */
export function collectCodeAgentEvents(
  messages: Message[],
  taskId: string,
): CodeAgentTranscriptEvent[] {
  const events: Array<{ event: CodeAgentTranscriptEvent; at: number; order: number }> = [];
  const records = foldSessionTranscript(messages, taskId);
  // The backend's user_direct_turn row and the session's own user record are one
  // turn (direct_turn_id = client_message_id); rows without an id match by text.
  const personRecords = records.filter(
    (r) => r.at !== null && r.type === 'message' && r.role === 'user' && r.sender === 'user',
  );
  const echoedTurnIds = new Set(personRecords.flatMap((r) => r.clientMessageId ?? []));
  const echoedTexts = new Set(personRecords.map((r) => r.text));
  // A Rose → code-agent message renders once, from its clean a2a row (code_turn_id).
  const delivered = deliveredAgentTurnIds(messages, taskId);
  for (const entry of records) {
    if (entry.at === null) continue;
    if (entry.type !== 'thinking' && entry.type !== 'message' && entry.type !== 'tool') continue;
    if (isDeliveredAgentRecord(entry, delivered)) continue;
    const at = entry.at ?? entry.firstSeenAt ?? 0;
    const ts = entry.at ?? entry.firstSeenAt ?? 0;
    events.push({
      event: {
        type: entry.type,
        ts,
        text: entry.text || undefined,
        tool: entry.tool,
        role: entry.role,
        sender: entry.role === 'user' ? entry.sender : undefined,
      },
      at,
      order: events.length,
    });
  }
  for (const message of messages) {
    const metadata = message.metadata;
    if (!metadata || metadata.task_id !== taskId) continue;
    const actionType: unknown = metadata.action_type;
    const at = eventTimeMs(message.timestamp) ?? 0;
    if (actionType === 'agent_message') {
      const a2a = parseAgentToAgentMessage(message);
      if (a2a) {
        events.push({
          event: { type: 'agent_message', ts: message.timestamp, a2a },
          at,
          order: events.length,
        });
      }
    } else if (actionType === 'user_direct_turn' && str(message.text)) {
      const turnId = str(metadata.direct_turn_id);
      if (turnId ? echoedTurnIds.has(turnId) : echoedTexts.has(message.text)) continue;
      events.push({
        event: { type: 'message', role: 'user', ts: message.timestamp, text: message.text },
        at,
        order: events.length,
      });
    }
  }
  return events.sort((a, b) => a.at - b.at || a.order - b.order).map(({ event }) => event);
}

/** CLI turn ids that the backend's a2a rows of this session were delivered as. */
export function deliveredAgentTurnIds(messages: Message[], taskId: string): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.task_id !== taskId || metadata.action_type !== 'agent_message') continue;
    const id = str(metadata.code_turn_id);
    if (id) ids.add(id);
  }
  return ids;
}

/** The session's own (LLM-framed) copy of a message Rose delivered as an a2a row. */
export function isDeliveredAgentRecord(entry: TranscriptEntry, delivered: Set<string>): boolean {
  if (entry.type !== 'message' || entry.role !== 'user' || entry.sender !== 'agent') return false;
  return agentRecordTurnId(entry, delivered) !== null;
}

/** The delivered turn id this record carries (client_message_id, else its `turn:<id>` key). */
export function agentRecordTurnId(entry: TranscriptEntry, delivered: Set<string>): string | null {
  const candidates = [entry.clientMessageId, entry.key.replace(/^turn:/, '')];
  return candidates.find((id): id is string => !!id && delivered.has(id)) ?? null;
}

/** Session provider from its records (first record that names one). */
export function transcriptProvider(messages: Message[], taskId: string): CodeAgentProvider | null {
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.task_id !== taskId || !Array.isArray(metadata.code_agent_events)) continue;
    for (const value of metadata.code_agent_events) {
      const p = rec(value)?.provider;
      if (p === 'claude' || p === 'codex') return p;
    }
  }
  return null;
}
