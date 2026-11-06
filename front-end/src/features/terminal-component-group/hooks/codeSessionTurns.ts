/**
 * One shared presentation layer for a code session (Claude Code + Codex) on
 * top of the main-chat message model: the folded transcript becomes ordinary
 * `Message`s (rendered by MessageListItems, the main chat's renderer), with
 * each native turn's work compressed into ONE slot.
 *
 *   person's turn        → USER message (key turn:<client_message_id> from the
 *                          optimistic echo through the direct-turn row to the
 *                          session's own record: one row, never duplicated)
 *   Rose's initial goal  → USER message, like the goal prompt of a root agent
 *   agent coordination: later native Rose → code-agent messages and the canonical
 *   a2a rows of this code agent (rose-agents send, either direction)
 *                        → agent-to-agent activity rows inside the running turn's
 *                          WORK SLOT, else the latest slot, else the next one (a
 *                          Rose message while none runs starts one). One row per
 *                          [from, to, message_id] (the work groups' comms identity):
 *                          canonical mirrors fold away. Never a top-level row.
 *   thinking / narration / tools / control  → the turn's WORK SLOT (never top-level)
 *   final answer (result text, else the last narration once the turn ends)
 *                        → final-answer row after the slot
 *   error                → error tool row outside the slot
 *   display media / send_message_to_user of THIS code agent
 *                        → as-is, outside the slot
 *
 * TURNS (key provider:task:<turn id, else nN> fixed when the slot is created, so a
 * turn id arriving later never remounts it): a person/Rose message while no turn runs
 * starts one; while one runs it is a steer and the same slot keeps updating.
 * `turn_id` on records, when the backend sends it, decides instead. A result /
 * error record ends the turn: duration = turn start (turn_started_at, else the
 * opening message's time) → stop (turn_ended_at, else the result's time);
 * outcome from `outcome`, else result status / error. A session that ended
 * with a turn still open: paused → interrupted, failed → failed, at the
 * session's ended_at. Never a tool-time sum or a render clock.
 */

import type { Message } from '@/lib/api/types';

import {
  codeAgentLabel,
  eventTimeMs,
  parseAgentToAgentMessage,
  type CodeAgentProvider,
} from './codeAgentContract';
import type { LocalEcho } from './codeAgentLocalState';
import {
  agentRecordTurnId,
  deliveredAgentTurnIds,
  foldSessionTranscript,
  type TranscriptEntry,
  type TurnOutcome,
} from './codeSessionTranscript';

export type WorkStatus = 'running' | TurnOutcome;

export interface WorkTurnMetrics {
  outputTokens?: number;
  scope?: 'turn' | 'session';
  sampledAt: number | null;
  tokensPerSecond?: number;
}

export interface WorkTurn {
  key: string;
  status: WorkStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** Ordered activity rows (main-chat messages), oldest first. */
  activities: Message[];
  /** "Explored 2 files, searched code, ran 4 commands"; null without tool events. */
  summary: string | null;
  streamingMessageId?: string;
  isThinking?: boolean;
  activityType?: 'thinking' | 'message' | 'tool' | 'control';
  metrics?: WorkTurnMetrics;
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
    // The shared thought row (metadata.generation is added by the usage samples around it).
    const live = entry.partial === true;
    return {
      ...base,
      role: 'TOOL',
      text: entry.text,
      metadata: {
        toolName: 'thought',
        toolStatus: live ? 'IN_PROGRESS' : 'FINISHED',
        title: live ? 'Thinking' : 'Thought',
        toolCallId: id,
      },
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
  metricSample?: { count: number; at: number | null; scope: 'turn' | 'session' };
  metricBaseline?: number;
}

class SessionBuilder {
  readonly out: CodeSessionEntry[] = [];
  private open: OpenTurn | null = null;
  private turnCount = 0;
  private readonly comms = new Set<string>();
  /** Coordination before any slot exists: joins the next slot. */
  private pendingComms: Message[] = [];

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
    this.open.turn.activities.push(...this.pendingComms);
    this.pendingComms = [];
    this.out.push({ kind: 'work', key, turn: this.open.turn });
  }

  /** Seen [from, to, message_id] → null (a mirror); else the row, direction from this agent. */
  private commsRow(message: Message): Message | null {
    const a2a = parseAgentToAgentMessage(message);
    if (!a2a) return message;
    // The work groups' comms identity (trajectoryWorkGroups.trajectoryActivity).
    const key = JSON.stringify([a2a.from.id, a2a.to.id, a2a.message_id]);
    if (this.comms.has(key)) return null;
    this.comms.add(key);
    const { taskId } = this.input;
    const direction =
      a2a.from.id === taskId ? 'sent' : a2a.to.id === taskId ? 'received' : a2a.direction;
    const raw = message.metadata?.a2a as Record<string, unknown>;
    return { ...message, metadata: { ...message.metadata, a2a: { ...raw, direction } } };
  }

  private finish(outcome: TurnOutcome, endedAt: number | null) {
    const open = this.open;
    if (!open) return;
    open.turn.status = outcome;
    open.turn.endedAt = endedAt;
    this.open = null;
  }

  /**
   * Agent coordination as a work activity. `starts`: a native Rose message (starts a
   * turn when none runs); else a canonical a2a row (running, else latest, else next slot).
   */
  coordination(message: Message, at: number | null, turnId: string | null, starts: boolean) {
    const row = this.commsRow(message);
    if (row === null) return;
    const running = this.open;
    if (running && turnId !== null && running.turnId !== null && running.turnId !== turnId) {
      this.finish('interrupted', at);
    }
    if (!this.open && !starts) {
      const latest = [...this.out].reverse().find((item) => item.kind === 'work');
      if (latest?.kind === 'work') latest.turn.activities.push(row);
      else this.pendingComms.push(row);
      return;
    }
    if (!this.open) this.startTurn(at, turnId);
    (this.open as OpenTurn).turn.activities.push(row);
  }

  /** Coordination that never met a slot still folds into one (never top-level). */
  flushComms() {
    const first = this.pendingComms[0];
    if (first) this.startTurn(eventTimeMs(first.timestamp), null);
  }

  /** Nothing rendered yet: the session's first message is its goal prompt. */
  get empty(): boolean {
    return this.out.length === 0;
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
      // The slot keeps the key it was created with: a turn id arriving later never
      // remounts it (its expand and page state survive).
      this.open.turnId = entry.turnId;
      this.open.turn.startedAt = entry.turnStartedAt ?? this.open.turn.startedAt;
    }
  }

  activity(entry: TranscriptEntry) {
    if (this.open && entry.turnId && this.open.turnId && entry.turnId !== this.open.turnId)
      this.finish('interrupted', entry.at);
    if (!this.open)
      this.startTurn(entry.turnStartedAt ?? entry.at ?? entry.firstSeenAt, entry.turnId);
    const open = this.open as OpenTurn;
    if (entry.turnStartedAt != null) open.turn.startedAt = entry.turnStartedAt;
    if (entry.turnId && !open.turnId) open.turnId = entry.turnId;
    if (!open.emitted) {
      open.emitted = true;
      this.out.push({ kind: 'work', key: open.turn.key, turn: open.turn });
    }
    open.turn.activityType =
      entry.type === 'thinking' || entry.type === 'message' || entry.type === 'tool'
        ? entry.type
        : 'control';
    const id = this.id(entry.key);
    open.turn.isThinking = entry.type === 'thinking' && entry.partial === true;
    open.turn.streamingMessageId =
      entry.type === 'message' && entry.partial === true ? id : undefined;
    open.turn.activities.push(activityMessage(entry, id));
    if (entry.type === 'tool') open.tools.push(entry);
    if (entry.type === 'message') open.lastNarration = { entry, id };
    open.turn.summary = summarize(open.tools);
  }

  metrics(entry: TranscriptEntry) {
    const open = this.open;
    if (!open || (entry.turnId && open.turnId && entry.turnId !== open.turnId)) return;
    const previous = open.metricSample;
    const count = entry.outputTokens;
    const scope = entry.usageScope;
    const at = entry.at;
    if (count == null || !scope) return;
    const reset = !previous || previous.scope !== scope || count < previous.count;
    if (reset) open.metricBaseline = count;
    const elapsed = at != null && previous?.at != null ? (at - previous.at) / 1000 : 0;
    open.turn.metrics = {
      outputTokens:
        scope === 'turn' ? count : !reset ? count - (open.metricBaseline ?? count) : undefined,
      scope,
      sampledAt: at,
      tokensPerSecond: !reset && elapsed > 0 ? (count - previous!.count) / elapsed : undefined,
    };
    open.metricSample = { count, at, scope };
    // A thought's generation: the producer samples usage at each model call's start and
    // end, so the samples around a thinking record bracket the call that generated it
    // (a turn-scoped counter starts at 0 with the turn). A window a tool finished inside
    // spans a tool run, not generation: no rate rather than a wrong one.
    const from =
      !reset && previous
        ? previous
        : scope === 'turn' && open.turn.startedAt !== null
          ? { count: 0, at: open.turn.startedAt }
          : null;
    if (!from || from.at === null || at === null || at <= from.at || count <= from.count) return;
    const inside = (message: Message) => {
      const time = eventTimeMs(message.timestamp);
      return time !== null && time > from.at! && time <= at;
    };
    const activities = open.turn.activities;
    const toolRan = activities.some(
      (message) =>
        message.metadata?.toolName !== 'thought' &&
        message.metadata?.toolStatus === 'FINISHED' &&
        message.role === 'TOOL' &&
        message.metadata?.a2a === undefined &&
        message.metadata?.isUserAttentionMessage !== true &&
        inside(message),
    );
    if (toolRan) return;
    const generation = {
      output_tokens: count - from.count,
      started_at: iso(from.at),
      ended_at: iso(at),
    };
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const message = activities[index];
      const time = eventTimeMs(message.timestamp);
      if (time !== null && time <= from.at) break;
      if (message.metadata?.toolName !== 'thought' || message.metadata.generation) continue;
      if (message.metadata.toolStatus !== 'FINISHED' || !inside(message)) continue;
      activities[index] = { ...message, metadata: { ...message.metadata, generation } };
    }
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
  // A Rose → code-agent message is one row: its clean a2a row (code_turn_id) placed
  // where the session's own framed copy of the turn sits; the framed copy never renders.
  const delivered = deliveredAgentTurnIds(input.messages, input.taskId);
  const canonicalByTurn = new Map<string, Message>();
  for (const message of input.messages) {
    // Only this session's a2a rows: codeTurnId hashes sender + message_id (no target),
    // so another session's row can carry the same id.
    const metadata = message.metadata;
    const id = metadata?.code_turn_id;
    if (metadata?.task_id !== input.taskId) continue;
    if ((metadata.action_type as string) !== 'agent_message') continue;
    if (typeof id === 'string' && delivered.has(id)) canonicalByTurn.set(id, message);
  }
  const placedTurns = new Set(
    records.flatMap((entry) =>
      entry.type === 'message' && entry.role === 'user' && entry.sender === 'agent'
        ? (agentRecordTurnId(entry, delivered) ?? [])
        : [],
    ),
  );
  for (const item of buildTimeline(input, records)) {
    if (item.kind === 'row') {
      const turnId = item.message.metadata?.code_turn_id;
      if (typeof turnId === 'string' && placedTurns.has(turnId)) {
        // Placed at the session's own record of that turn (below).
      } else if ((item.message.metadata?.action_type as string) === 'agent_message') {
        builder.coordination(item.message, item.at, null, false);
      } else {
        builder.out.push({ kind: 'message', key: item.message.message_id, message: item.message });
      }
    } else if (item.kind === 'person') {
      const id = `code:${input.taskId}:${item.key}`;
      builder.person(personMessage(id, item.text, item.at), item.at, item.turnId);
    } else {
      const { entry } = item;
      if (entry.type === 'message' && entry.role === 'user') {
        const key = entry.clientMessageId ? `turn:${entry.clientMessageId}` : entry.key;
        const id = `code:${input.taskId}:${key}`;
        const at = entry.at ?? item.at;
        const deliveredAs = entry.sender === 'agent' ? agentRecordTurnId(entry, delivered) : null;
        const canonical = deliveredAs !== null ? canonicalByTurn.get(deliveredAs) : undefined;
        if (canonical) {
          builder.coordination(canonical, at, entry.turnId, true);
        } else if (entry.sender === 'agent' && !builder.empty) {
          builder.coordination(roseMessage(input, id, entry), at, entry.turnId, true);
        } else {
          builder.person(personMessage(id, entry.text, at), at, entry.turnId, entry.turnStartedAt);
        }
      } else if (entry.type === 'metrics') {
        builder.metrics(entry);
      } else if (entry.type === 'turn') {
        builder.lifecycle(entry);
      } else if (entry.type === 'result' || entry.type === 'error') {
        builder.end(entry);
      } else {
        builder.activity(entry);
      }
    }
  }
  builder.flushComms();
  builder.close();
  return builder.out;
}
