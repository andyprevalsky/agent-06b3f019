/**
 * One shared presentation layer for a code session (Claude Code + Codex) on
 * top of the main-chat message model: the folded transcript becomes ordinary
 * `Message`s (rendered by MessageListItems, the main chat's renderer), with
 * each native turn's work compressed into ONE slot.
 *
 *   person's turn        → USER message (key turn:<client_message_id> from the
 *                          optimistic echo through the direct-turn row to the
 *                          session's own record: one row, never duplicated)
 *   Rose's goal/message  → agent-to-agent row ("Rose → Codex")
 *   thinking / narration / tools / control  → the turn's WORK SLOT (never top-level)
 *   final answer (result text, else the last narration once the turn ends)
 *                        → final-answer row after the slot
 *   error                → error tool row outside the slot
 *   a2a rows, display media / send_message_to_user of THIS code agent
 *                        → as-is, outside the slot
 *
 * TURNS (key provider:task:turn): a person/Rose message while no turn runs
 * starts one; while one runs it is a steer and the same slot keeps updating.
 * `turn_id` on records, when the backend sends it, decides instead. A result /
 * error record ends the turn: duration = turn start (turn_started_at, else the
 * opening message's time) → stop (turn_ended_at, else the result's time);
 * outcome from `outcome`, else result status / error. A session that ended
 * with a turn still open: paused → interrupted, failed → failed, at the
 * session's ended_at. Never a tool-time sum or a render clock.
 */

import type { Message } from '@/lib/api/types';

import { codeAgentLabel, eventTimeMs, type CodeAgentProvider } from './codeAgentContract';
import type { LocalEcho } from './codeAgentLocalState';
import {
  foldSessionTranscript,
  type TranscriptEntry,
  type TurnOutcome,
} from './codeSessionTranscript';

export type WorkStatus = 'running' | TurnOutcome;

export interface WorkTurn {
  key: string;
  status: WorkStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** Ordered activity rows (main-chat messages), oldest first. */
  activities: Message[];
  /** "Explored 2 files, searched code, ran 4 commands"; null without tool events. */
  summary: string | null;
}

export type CodeSessionEntry =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'work'; key: string; turn: WorkTurn };

export interface CodeSessionInput {
  messages: Message[];
  taskId: string;
  ownerAgentId: string;
  provider: CodeAgentProvider;
  /** The session snapshot: decides how an open turn reads once the session ended. */
  sessionState: 'running' | 'completed' | 'failed' | 'paused';
  sessionEndedAt: number | null;
  echoes: readonly LocalEcho[];
}

// ── Duration / summary text ─────────────────────────────────────────────────

export function formatWorkDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const total = Math.floor(safe / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** "Worked for 57.7s" / "Interrupted after 12.0s" / "Failed after 8.0s" / "Working". */
export function workLabel(turn: Pick<WorkTurn, 'status' | 'startedAt' | 'endedAt'>): string {
  if (turn.status === 'running') return 'Working';
  const lead =
    turn.status === 'completed' ? 'Worked' : turn.status === 'failed' ? 'Failed' : 'Interrupted';
  if (turn.startedAt === null || turn.endedAt === null || turn.endedAt < turn.startedAt)
    return lead;
  const joiner = turn.status === 'completed' ? 'for' : 'after';
  return `${lead} ${joiner} ${formatWorkDuration(turn.endedAt - turn.startedAt)}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function summarize(tools: TranscriptEntry[]): string | null {
  if (tools.length === 0) return null;
  const files = (category: string) =>
    new Set(tools.filter((t) => t.tool?.category === category).map((t) => t.tool?.target)).size;
  const count = (category: string) => tools.filter((t) => t.tool?.category === category).length;
  const parts: string[] = [];
  const read = files('read');
  if (read > 0) parts.push(`explored ${read} ${plural(read, 'file', 'files')}`);
  const search = count('search');
  if (search > 0) parts.push(search === 1 ? 'searched code' : `searched code ${search} times`);
  const edited = files('edit');
  if (edited > 0) parts.push(`edited ${edited} ${plural(edited, 'file', 'files')}`);
  const run = count('run');
  if (run > 0) parts.push(`ran ${run} ${plural(run, 'command', 'commands')}`);
  const other = count('other');
  if (other > 0) parts.push(`used ${other} ${plural(other, 'tool', 'tools')}`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Records → main-chat messages ────────────────────────────────────────────

function iso(at: number | null): string {
  return new Date(at ?? 0).toISOString();
}

function toolTitle(entry: TranscriptEntry): string {
  const tool = entry.tool;
  if (!tool) return entry.text || 'Tool';
  const parts = [tool.name, tool.target].filter((p) => p !== '');
  if (tool.added !== undefined || tool.removed !== undefined) {
    parts.push(`+${tool.added ?? 0} −${tool.removed ?? 0}`);
  }
  if (tool.result) parts.push(tool.result);
  return parts.join(' ');
}

function activityMessage(entry: TranscriptEntry, id: string): Message {
  const base = { message_id: id, timestamp: iso(entry.at ?? entry.firstSeenAt) };
  if (entry.type === 'message') return finalAnswer(entry.text, id, entry.at ?? entry.firstSeenAt);
  if (entry.type === 'thinking') {
    return {
      ...base,
      role: 'TOOL',
      text: entry.text,
      metadata: { toolName: 'thought', toolStatus: 'FINISHED', title: 'Thought', toolCallId: id },
    };
  }
  const running = entry.tool?.status === 'running';
  return {
    ...base,
    role: 'TOOL',
    text: entry.tool?.output ?? '',
    metadata: {
      toolName: entry.tool?.name ?? entry.type,
      toolStatus: running ? 'IN_PROGRESS' : 'FINISHED',
      title: entry.type === 'tool' ? toolTitle(entry) : entry.text,
      toolCallId: id,
      error: entry.tool?.status === 'error',
    },
  };
}

function finalAnswer(text: string, id: string, at: number | null): Message {
  return {
    message_id: id,
    timestamp: iso(at),
    role: 'TOOL',
    text,
    metadata: {
      isUserAttentionMessage: true,
      attentionMessage: text,
      toolStatus: 'FINISHED',
      toolCallId: id,
      title: 'Answer',
    },
  };
}

// ── Timeline (records + this code agent's own rows) ─────────────────────────

type TimelineItem =
  | { kind: 'record'; at: number; entry: TranscriptEntry }
  | { kind: 'person'; at: number; key: string; text: string; turnId: string | null }
  | { kind: 'row'; at: number; message: Message };

function isOwnUserFacingRow(message: Message, taskId: string): boolean {
  const metadata = message.metadata;
  if (!metadata) return false;
  if ((metadata.action_type as string) === 'agent_message' && metadata.task_id === taskId)
    return true;
  const requester = (metadata.requestingAgent ?? metadata.displayedBy) as
    { kind?: unknown; task_id?: unknown } | undefined;
  if (requester?.kind !== 'code_agent' || requester.task_id !== taskId) return false;
  const display = metadata.display as { placement?: unknown } | undefined;
  if (display?.placement === 'pinned') return false; // shown above the query box
  return (
    metadata.toolName === 'send_message_to_user' ||
    metadata.toolName === 'send_message_to_user_execute_phase' ||
    (message.role === 'ASSISTANT' && message.file_pointer !== undefined && display !== undefined)
  );
}

function buildTimeline(input: CodeSessionInput, records: TranscriptEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let anchor = 0;
  for (const entry of records) {
    // Monotonic anchors keep records in creation order when rows interleave.
    anchor = Math.max(anchor, entry.at ?? entry.firstSeenAt ?? anchor);
    items.push({ kind: 'record', at: anchor, entry });
  }
  const persons = new Set(
    records
      .filter((r) => r.type === 'message' && r.role === 'user')
      .map((r) => (r.clientMessageId ? `turn:${r.clientMessageId}` : `text:${r.text}`)),
  );
  const personTexts = new Set(
    records.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.text),
  );
  const seen = (key: string, text: string) =>
    persons.has(key) || (!key.startsWith('turn:') && personTexts.has(text));
  const displays = new Set<string>();
  for (const message of input.messages) {
    const metadata = message.metadata;
    const at = eventTimeMs(message.timestamp) ?? 0;
    if (
      metadata?.task_id === input.taskId &&
      (metadata.action_type as string) === 'user_direct_turn'
    ) {
      const turnId = typeof metadata.direct_turn_id === 'string' ? metadata.direct_turn_id : null;
      const key = turnId ? `turn:${turnId}` : `row:${message.message_id}`;
      if (message.text && !seen(key, message.text)) {
        items.push({ kind: 'person', at, key, text: message.text, turnId: null });
        persons.add(key);
        personTexts.add(message.text);
      }
    } else if (isOwnUserFacingRow(message, input.taskId)) {
      const display = metadata?.display as
        { canonical_id?: string; conversation?: string } | undefined;
      if (display?.conversation === 'parent') continue;
      const displayKey = display?.canonical_id
        ? `${display.canonical_id}:${message.file_pointer?.storage_path ?? ''}`
        : null;
      if (displayKey && displays.has(displayKey)) continue;
      if (displayKey) displays.add(displayKey);
      items.push({ kind: 'row', at, message });
    }
  }
  for (const echo of input.echoes) {
    const key = echo.id ? `turn:${echo.id}` : `echo:${echo.at}`;
    if (!seen(key, echo.text)) {
      items.push({ kind: 'person', at: echo.at, key, text: echo.text, turnId: null });
    }
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at - b.item.at || a.index - b.index)
    .map(({ item }) => item);
}

// ── Grouping ────────────────────────────────────────────────────────────────

interface OpenTurn {
  turn: WorkTurn;
  turnId: string | null;
  emitted: boolean;
  tools: TranscriptEntry[];
  /** Last narration record (becomes the final answer when the turn ends). */
  lastNarration: { entry: TranscriptEntry; id: string } | null;
}

class SessionBuilder {
  readonly out: CodeSessionEntry[] = [];
  private open: OpenTurn | null = null;
  private turnCount = 0;

  constructor(private readonly input: CodeSessionInput) {}

  private id(key: string) {
    return `code:${this.input.taskId}:${key}`;
  }

  private startTurn(at: number | null, turnId: string | null) {
    this.turnCount += 1;
    const key = `${this.input.provider}:${this.input.taskId}:${turnId ?? `n${this.turnCount}`}`;
    this.open = {
      turn: { key, status: 'running', startedAt: at, endedAt: null, activities: [], summary: null },
      turnId,
      emitted: true,
      tools: [],
      lastNarration: null,
    };
    this.out.push({ kind: 'work', key, turn: this.open.turn });
  }

  private finish(outcome: TurnOutcome, endedAt: number | null) {
    const open = this.open;
    if (!open) return;
    open.turn.status = outcome;
    open.turn.endedAt = endedAt;
    this.open = null;
  }

  /** A person's (or Rose's) message: steer the running turn or start the next. */
  person(message: Message, at: number | null, turnId: string | null, startedAt?: number | null) {
    const running = this.open;
    if (running && turnId !== null && running.turnId !== null && running.turnId !== turnId) {
      this.finish('interrupted', at);
    }
    this.out.push({ kind: 'message', key: message.message_id, message });
    if (!this.open) this.startTurn(startedAt ?? at, turnId);
  }

  lifecycle(entry: TranscriptEntry) {
    if (entry.event === 'ended') {
      this.end(entry);
      return;
    }
    if (this.open && this.open.turnId && this.open.turnId !== entry.turnId)
      this.finish('interrupted', entry.at);
    if (!this.open) this.startTurn(entry.turnStartedAt ?? entry.at, entry.turnId);
    if (this.open) {
      this.open.turnId = entry.turnId;
      this.open.turn.key = `${this.input.provider}:${this.input.taskId}:${entry.turnId ?? `n${this.turnCount}`}`;
      this.open.turn.startedAt = entry.turnStartedAt ?? this.open.turn.startedAt;
      const slot = this.out.find((item) => item.kind === 'work' && item.turn === this.open?.turn);
      if (slot) slot.key = this.open.turn.key;
    }
  }

  activity(entry: TranscriptEntry) {
    if (this.open && entry.turnId && this.open.turnId && entry.turnId !== this.open.turnId)
      this.finish('interrupted', entry.at);
    if (!this.open)
      this.startTurn(entry.turnStartedAt ?? entry.at ?? entry.firstSeenAt, entry.turnId);
    const open = this.open as OpenTurn;
    if (entry.turnStartedAt != null) open.turn.startedAt = entry.turnStartedAt;
    if (entry.turnId && !open.turnId) {
      open.turnId = entry.turnId;
      open.turn.key = `${this.input.provider}:${this.input.taskId}:${entry.turnId}`;
      const slot = this.out.find((item) => item.kind === 'work' && item.turn === open.turn);
      if (slot) slot.key = open.turn.key;
    }
    if (!open.emitted) {
      open.emitted = true;
      this.out.push({ kind: 'work', key: open.turn.key, turn: open.turn });
    }
    const id = this.id(entry.key);
    open.turn.activities.push(activityMessage(entry, id));
    if (entry.type === 'tool') open.tools.push(entry);
    if (entry.type === 'message') open.lastNarration = { entry, id };
    open.turn.summary = summarize(open.tools);
  }

  end(entry: TranscriptEntry) {
    const open = this.open;
    const failed = entry.type === 'error' || entry.status === 'failed';
    const outcome: TurnOutcome = entry.outcome ?? (failed ? 'failed' : 'completed');
    if (open && entry.turnStartedAt != null) open.turn.startedAt = entry.turnStartedAt;
    const endedAt = entry.turnEndedAt ?? entry.at ?? entry.firstSeenAt;
    const narration = open?.lastNarration ?? null;
    this.finish(outcome, endedAt);
    if (entry.type === 'error') {
      const id = this.id(entry.key);
      this.out.push({
        kind: 'message',
        key: id,
        message: {
          message_id: id,
          timestamp: iso(endedAt),
          role: 'TOOL',
          text: '',
          metadata: { toolName: 'error', toolStatus: 'ERROR', error: true, title: entry.text },
        },
      });
      return;
    }
    // The final answer leaves the slot (same id it had there) and follows it.
    const answerText =
      entry.text.trim() !== ''
        ? entry.text
        : outcome === 'completed'
          ? (narration?.entry.text ?? '')
          : '';
    if (answerText.trim() === '') return;
    const sameAsNarration = narration !== null && narration.entry.text.trim() === answerText.trim();
    if (open && sameAsNarration && narration) {
      open.turn.activities = open.turn.activities.filter((m) => m.message_id !== narration.id);
    }
    const id = sameAsNarration && narration ? narration.id : this.id(entry.key);
    this.out.push({ kind: 'message', key: id, message: finalAnswer(answerText, id, endedAt) });
  }

  close() {
    if (!this.open) return;
    const { sessionState, sessionEndedAt } = this.input;
    if (sessionState === 'running') return;
    const outcome: TurnOutcome =
      sessionState === 'paused'
        ? 'interrupted'
        : sessionState === 'failed'
          ? 'failed'
          : 'completed';
    const open = this.open;
    const narration = open.lastNarration;
    this.finish(outcome, sessionEndedAt);
    if (outcome === 'completed' && narration) {
      open.turn.activities = open.turn.activities.filter(
        (message) => message.message_id !== narration.id,
      );
      this.out.push({
        kind: 'message',
        key: narration.id,
        message: finalAnswer(narration.entry.text, narration.id, sessionEndedAt),
      });
    }
  }
}

function personMessage(id: string, text: string, at: number): Message {
  return { message_id: id, timestamp: iso(at), role: 'USER', text };
}

function roseMessage(input: CodeSessionInput, id: string, entry: TranscriptEntry): Message {
  const label = codeAgentLabel(input.provider);
  return {
    message_id: id,
    timestamp: iso(entry.at ?? entry.firstSeenAt),
    role: 'TOOL',
    text: entry.text,
    metadata: {
      code_provider: input.provider,
      a2a: {
        kind: 'message',
        message_id: entry.key,
        direction: 'received',
        text: entry.text,
        from: { id: input.ownerAgentId, kind: 'agent', label: 'Rose' },
        to: { id: input.taskId, kind: 'code', provider: input.provider, label },
      },
    },
  };
}

/** The code session as main-chat entries: messages outside, one work slot per turn. */
export function buildCodeSession(input: CodeSessionInput): CodeSessionEntry[] {
  const records = foldSessionTranscript(input.messages, input.taskId);
  const builder = new SessionBuilder(input);
  for (const item of buildTimeline(input, records)) {
    if (item.kind === 'row') {
      builder.out.push({ kind: 'message', key: item.message.message_id, message: item.message });
    } else if (item.kind === 'person') {
      const id = `code:${input.taskId}:${item.key}`;
      builder.person(personMessage(id, item.text, item.at), item.at, item.turnId);
    } else {
      const { entry } = item;
      if (entry.type === 'message' && entry.role === 'user') {
        const key = entry.clientMessageId ? `turn:${entry.clientMessageId}` : entry.key;
        const id = `code:${input.taskId}:${key}`;
        const message =
          entry.sender === 'agent'
            ? roseMessage(input, id, entry)
            : personMessage(id, entry.text, entry.at ?? item.at);
        builder.person(message, entry.at ?? item.at, entry.turnId, entry.turnStartedAt);
      } else if (entry.type === 'turn') {
        builder.lifecycle(entry);
      } else if (entry.type === 'result' || entry.type === 'error') {
        builder.end(entry);
      } else {
        builder.activity(entry);
      }
    }
  }
  builder.close();
  return builder.out;
}
