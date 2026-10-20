/**
 * Code-agent steering contract (Rose Desktop, UI ledger rows 44-47 and 51).
 *
 * The ONE adapter between the backend and the code-agent steering UI: every
 * wire shape the UI reads or writes lives here; change this file (and its
 * blackbox fixtures) when the contract moves, and nothing else.
 *
 *   agent:<rootId> realtime INSERT/UPDATE (existing message path)
 *     ├─ metadata.code_agent            → CodeAgentMeta    (chip lifecycle, target, summary)
 *     ├─ metadata.code_agent_events[]   → transcript events (task-scoped rows, hidden from root)
 *     ├─ metadata.requestingAgent       → RequestingAgent  (who sent a display / message /
 *     │                                   approval / question; L-DISPLAY b10b038c1)
 *     ├─ TOOL 'display' + metadata.display {placement 'pinned', kind 'question', question,
 *     │    options, allow_other, question_id, items, deliver_to 'user', routed_agent_id}:
 *     │    IN_PROGRESS → pinned above the query box; FINISHED (answered) → unpinned
 *     ├─ ASSISTANT + file_pointer + metadata.display {placement 'inline', kind 'media',
 *     │    sha256, mime_type, caption?} → one item of an inline media gallery
 *     ├─ TOOL send_message_to_user + inlineView {view, versionId, props}; code-agent rows
 *     │    carry subAgentId = task yet still show in the root trajectory
 *     └─ metadata.a2a                   → agent-to-agent message (backend agentGraphSendService):
 *          TOOL row, action_type 'agent_message', a2a.direction, task_id/subAgentId = code session
 *            → code agent's own timeline ("Codex → Rose" / "Rose → Codex")
 *          USER row on the recipient Rose agent → never a user bubble
 *          a2a.kind 'question' → inline question (routed to a parent agent, row 47b)
 *     └─ action_type 'user_direct_turn' (TOOL, task_id) → "You → <agent>" transcript row
 *   GET /api/attention-requests (the existing app-wide subscription)
 *     └─ metadata.agentTools {kind 'question', deliverTo 'user', routedAgentId = root} on a
 *        DESCENDANT agent → that sub-agent's pin shows above the root's query box
 *   POST /api/claude-code-session/:taskId/turns → steer the CLI session
 *        {client_message_id, text, tool_call_id?}; idempotent per client_message_id
 *   POST /api/agents/:id/questions/:questionId/answer {answer} | {dismiss: true}
 *        → 2xx (first answer wins) | 404 gone | 403 other account | 400 invalid answer
 *
 * Everything is parsed defensively: a missing or malformed field yields null so
 * the existing chip / bubble behavior stays in charge.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from '@/lib/api/client';
import type { FilePointer, Message } from '@/lib/api/types';

// ── Wire types ──────────────────────────────────────────────────────────────

export type CodeAgentProvider = 'claude' | 'codex';
export type CodeAgentTarget = 'cloud' | 'local';
export type CodeAgentState = 'spinning_up' | 'live' | 'completed' | 'failed';

/**
 * Canonical local-run failures (row 51). When `failure_kind` is set the UI
 * renders the exact canonical text; otherwise `failure_message` verbatim.
 */
export type CodeAgentFailureKind = 'local_disconnected' | 'local_requires_mac_app';

export interface CodeAgentFileChange {
  path: string;
  added: number;
  removed: number;
}

export interface CodeAgentSummary {
  commit: string;
  branch: string;
  merged_into?: string;
  tests_passed?: number;
  tests_total?: number;
  files: CodeAgentFileChange[];
  preview_url?: string;
}

/** `message.metadata.code_agent` */
export interface CodeAgentMeta {
  task_id: string;
  provider: CodeAgentProvider;
  target: CodeAgentTarget;
  device_name?: string;
  folder?: string;
  branch: string;
  /** Branch this agent merges into when done (the spawner's branch; row 50). */
  base_branch?: string;
  state: CodeAgentState;
  /** ISO-8601 or epoch ms. */
  started_at: string | number;
  ended_at?: string | number;
  failure_message?: string;
  failure_kind?: CodeAgentFailureKind;
  /** Short task subtitle shown after the status ("· nub tab behind the query box"). */
  title?: string;
  summary?: CodeAgentSummary;
}

export interface CodeAgentToolCall {
  name: string;
  target: string;
  added?: number;
  removed?: number;
  result?: string;
  /** true → result green, false → red, absent → muted. */
  ok?: boolean;
}

/**
 * One entry of `message.metadata.code_agent_events[]`, or (type 'agent_message')
 * an agent-to-agent timeline row of the same code session.
 */
export interface CodeAgentTranscriptEvent {
  type: 'thinking' | 'message' | 'tool' | 'agent_message';
  /** ISO-8601 or epoch ms. */
  ts: string | number;
  text?: string;
  tool?: CodeAgentToolCall;
  /** 'user' = a steering message echoed back by the session (default 'assistant'). */
  role?: 'assistant' | 'user';
  a2a?: AgentToAgentMessage;
}

/**
 * `metadata.requestingAgent` — who produced a display / message / approval /
 * question row (backend agent-tools RequestingAgent). Code agents carry their
 * provider and task; Rose agents their own title.
 */
export interface RequestingAgent {
  kind: 'code_agent' | 'agent';
  agent_id: string;
  /** Display name: "Codex" / "Claude Code" / "Rose" / a Rose sub-agent's title. */
  label: string;
  provider?: CodeAgentProvider;
  task_id?: string;
}

export interface PinnedQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** `message.metadata.display` for a pinned question (deliver_to 'user' only). */
export interface PinnedQuestionDisplay {
  placement: 'pinned';
  kind: 'question';
  question: string;
  options: PinnedQuestionOption[];
  allow_other: boolean;
  question_id: string;
  /** Media shown with the question. */
  items: FilePointer[];
  /** The agent whose query box shows the pin (the answer endpoint accepts it). */
  routed_agent_id?: string;
}

/** One inline `display` media item (ASSISTANT row + file_pointer). */
export interface DisplayMediaItem {
  file: FilePointer;
  mime_type: string;
  sha256?: string;
  /** Present on the first item of one display call only. */
  caption?: string;
  requester: RequestingAgent | null;
}

export type AgentToAgentKind = 'message' | 'question';

export interface AgentToAgentParty {
  id: string;
  kind: 'agent' | 'code';
  /** Code agents only (sender metadata, or the timeline row's `code_provider`). */
  provider?: CodeAgentProvider;
  /** Display name: "Codex" / "Claude Code" / "Rose" / a Rose sub-agent's title. */
  label: string;
}

/** `message.metadata.a2a`, normalized for display. */
export interface AgentToAgentMessage {
  kind: AgentToAgentKind;
  /** Present on code-agent timeline rows only. */
  direction?: 'sent' | 'received';
  message_id: string;
  from: AgentToAgentParty;
  to: AgentToAgentParty;
  /** The sender's own text (inbound LLM framing removed). */
  text: string;
}

// ── Display helpers ─────────────────────────────────────────────────────────

export function codeAgentLabel(provider: CodeAgentProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

/** Chip header target: "This Mac · <folder>" or "Cloud". */
export function codeAgentTargetLabel(meta: Pick<CodeAgentMeta, 'target' | 'folder'>): string {
  if (meta.target !== 'local') return 'Cloud';
  return meta.folder ? `This Mac · ${meta.folder}` : 'This Mac';
}

export interface CanonicalFailureText {
  lead: string;
  rest: string;
}

/** Exact row-51 texts; the lead sentence renders bold. */
export function localFailureText(
  kind: CodeAgentFailureKind,
  deviceName: string | undefined,
): CanonicalFailureText {
  if (kind === 'local_requires_mac_app') {
    return {
      lead: 'Local runs need an agent started from the Rose Mac app.',
      rest: 'Start this agent from the Mac app, or run it in the cloud.',
    };
  }
  return {
    lead: `Can't run locally: the Rose Mac app on ${deviceName || 'your Mac'} is closed or disconnected.`,
    rest: 'Open the Rose Mac app and retry, or run this agent in the cloud.',
  };
}

export function eventTimeMs(ts: string | number | undefined): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts.trim() !== '') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ── Parsers ─────────────────────────────────────────────────────────────────

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

function time(value: unknown): string | number | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function provider(value: unknown): CodeAgentProvider | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

const STATES: readonly CodeAgentState[] = ['spinning_up', 'live', 'completed', 'failed'];
const FAILURE_KINDS: readonly CodeAgentFailureKind[] = [
  'local_disconnected',
  'local_requires_mac_app',
];

function parseSummary(value: unknown): CodeAgentSummary | undefined {
  const r = rec(value);
  const commit = str(r?.commit);
  const branch = str(r?.branch);
  if (!r || !commit || !branch) return undefined;
  const files = Array.isArray(r.files)
    ? r.files.flatMap((f) => {
        const fr = rec(f);
        const path = str(fr?.path);
        if (!fr || !path) return [];
        return [{ path, added: num(fr.added) ?? 0, removed: num(fr.removed) ?? 0 }];
      })
    : [];
  return {
    commit,
    branch,
    merged_into: str(r.merged_into),
    tests_passed: num(r.tests_passed),
    tests_total: num(r.tests_total),
    files,
    preview_url: str(r.preview_url),
  };
}

export function parseCodeAgentMeta(value: unknown): CodeAgentMeta | null {
  const r = rec(value);
  if (!r) return null;
  const taskId = str(r.task_id);
  const prov = provider(r.provider);
  const state = STATES.find((s) => s === r.state);
  const startedAt = time(r.started_at);
  if (!taskId || !prov || !state || startedAt === undefined) return null;
  const failureKind = FAILURE_KINDS.find((k) => k === r.failure_kind);
  return {
    task_id: taskId,
    provider: prov,
    target: r.target === 'local' ? 'local' : 'cloud',
    device_name: str(r.device_name),
    folder: str(r.folder),
    branch: str(r.branch) ?? '',
    base_branch: str(r.base_branch),
    state,
    started_at: startedAt,
    ended_at: time(r.ended_at),
    failure_message: str(r.failure_message),
    failure_kind: failureKind,
    title: str(r.title),
    summary: parseSummary(r.summary),
  };
}

/** The spawn tool's error code for a local run that cannot start (L-LOCAL 4570ecefd). */
export const LOCAL_TARGET_UNAVAILABLE = 'LOCAL_TARGET_UNAVAILABLE';

/** A row of this code task: same task id, or (no task yet) the same spawn tool call. */
function isTaskRow(metadata: Message['metadata'], taskId: string, toolCallId?: string): boolean {
  const rowTask = str(metadata?.task_id);
  if (rowTask && rowTask !== 'pending') return rowTask === taskId;
  return toolCallId !== undefined && metadata?.toolCallId === toolCallId;
}

interface TaskFold {
  snapshot: Rec;
  provider: CodeAgentProvider | null;
  firstTs: string | number | undefined;
  state: CodeAgentState;
  failure?: string;
}

function foldTaskRow(fold: TaskFold, message: Message): void {
  const metadata = message.metadata;
  const partial = rec(metadata?.code_agent);
  if (partial) Object.assign(fold.snapshot, partial);
  fold.provider = fold.provider ?? provider(metadata?.code_provider);
  fold.firstTs = fold.firstTs ?? message.timestamp;
  const action: unknown = metadata?.action_type;
  if (metadata?.error_code === LOCAL_TARGET_UNAVAILABLE || metadata?.toolStatus === 'ERROR') {
    fold.state = 'failed';
    // The local-target error text is the exact user-facing message: shown verbatim.
    fold.failure = str(message.text) ?? fold.failure;
  } else if (action === 'task_complete') {
    fold.state = metadata?.success === false ? 'failed' : 'completed';
  } else if (action === 'claude_code_started' && fold.state === 'spinning_up') {
    fold.state = 'live';
  }
}

/**
 * The chip snapshot for one task: the backend writes PARTIAL `code_agent`
 * objects ({target, device_name, folder} from the local-target lane; richer
 * fields when present), so later rows merge over earlier ones and the rest
 * comes from the rows themselves (task_id, code_provider, lifecycle action,
 * first timestamp, LOCAL_TARGET_UNAVAILABLE text). No `code_agent` on any row,
 * or a present-but-invalid provider/state → null (stock chip).
 */
export function latestCodeAgentMeta(
  messages: Message[],
  taskId: string,
  toolCallId?: string,
): CodeAgentMeta | null {
  const fold: TaskFold = { snapshot: {}, provider: null, firstTs: undefined, state: 'spinning_up' };
  let seen = false;
  for (const message of messages) {
    if (!isTaskRow(message.metadata, taskId, toolCallId)) continue;
    if (rec(message.metadata?.code_agent)) seen = true;
    foldTaskRow(fold, message);
  }
  if (!seen) return null;
  const s = fold.snapshot;
  if (s.provider !== undefined && !provider(s.provider)) return null;
  if (s.state !== undefined && !STATES.some((state) => state === s.state)) return null;
  return parseCodeAgentMeta({
    ...s,
    task_id: str(s.task_id) ?? taskId,
    provider: s.provider ?? fold.provider ?? 'claude',
    state: s.state ?? fold.state,
    started_at: s.started_at ?? fold.firstTs,
    failure_message: s.failure_message ?? fold.failure,
  });
}

function parseEvent(value: unknown): CodeAgentTranscriptEvent | null {
  const r = rec(value);
  if (!r) return null;
  const type = r.type === 'thinking' || r.type === 'message' || r.type === 'tool' ? r.type : null;
  const ts = time(r.ts);
  if (!type || ts === undefined) return null;
  const toolRec = rec(r.tool);
  const toolName = str(toolRec?.name);
  const tool: CodeAgentToolCall | undefined =
    toolRec && toolName
      ? {
          name: toolName,
          target: typeof toolRec.target === 'string' ? toolRec.target : '',
          added: num(toolRec.added),
          removed: num(toolRec.removed),
          result: str(toolRec.result),
          ok: typeof toolRec.ok === 'boolean' ? toolRec.ok : undefined,
        }
      : undefined;
  if (type === 'tool' && !tool) return null;
  if (type !== 'tool' && !str(r.text)) return null;
  return { type, ts, text: str(r.text), tool, role: r.role === 'user' ? 'user' : 'assistant' };
}

/** Transcript events for one task, ordered by time (stable for equal times). */
export function collectCodeAgentEvents(
  messages: Message[],
  taskId: string,
): CodeAgentTranscriptEvent[] {
  const events: CodeAgentTranscriptEvent[] = [];
  for (const message of messages) {
    const metadata = message.metadata;
    if (!metadata || metadata.task_id !== taskId) continue;
    // These action types are not in the shared ClaudeCodeActionType union yet; read untyped.
    const actionType: unknown = metadata.action_type;
    if (actionType === 'agent_message') {
      const a2a = parseAgentToAgentMessage(message);
      if (a2a) events.push({ type: 'agent_message', ts: message.timestamp, a2a });
      continue;
    }
    if (actionType === 'user_direct_turn') {
      const text = str(message.text);
      if (text) events.push({ type: 'message', role: 'user', ts: message.timestamp, text });
      continue;
    }
    const raw = metadata.code_agent_events;
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      const event = parseEvent(entry);
      if (event) events.push(event);
    }
  }
  return events
    .map((event, index) => ({ event, index, at: eventTimeMs(event.ts) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ event }) => event);
}

/**
 * The backend labels Rose agents "Root agent" / "Agent" when untitled; the
 * desktop UI calls every Rose agent "Rose" unless it carries its own title.
 */
const GENERIC_ROSE_LABELS = new Set(['Root agent', 'Agent']);

function parseFilePointer(value: unknown): FilePointer | null {
  const r = rec(value);
  const id = str(r?.id);
  if (!r || !id || typeof r.storage_path !== 'string') return null;
  return {
    id,
    storage_path: r.storage_path,
    original_filename: str(r.original_filename) ?? id,
    mime_type: str(r.mime_type) ?? 'application/octet-stream',
    size_bytes: num(r.size_bytes) ?? 0,
    created_at: str(r.created_at) ?? '',
  };
}

function parseFilePointers(value: unknown): FilePointer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const file = parseFilePointer(item);
    return file ? [file] : [];
  });
}

/** `metadata.requestingAgent` (any copy of it), normalized for display. */
export function parseRequestingAgent(value: unknown): RequestingAgent | null {
  const r = rec(value);
  const agentId = str(r?.agent_id);
  if (!r || !agentId || (r.kind !== 'code_agent' && r.kind !== 'agent')) return null;
  const rawLabel = str(r.label)?.trim();
  if (r.kind === 'code_agent') {
    const prov = provider(r.provider);
    return {
      kind: 'code_agent',
      agent_id: agentId,
      label: prov ? codeAgentLabel(prov) : (rawLabel ?? 'Code agent'),
      provider: prov ?? undefined,
      task_id: str(r.task_id),
    };
  }
  return {
    kind: 'agent',
    agent_id: agentId,
    label: !rawLabel || GENERIC_ROSE_LABELS.has(rawLabel) ? 'Rose' : rawLabel,
  };
}

/** Requester of a row: `requestingAgent`, else the approval payload's copy. */
export function messageRequester(metadata: Message['metadata']): RequestingAgent | null {
  return (
    parseRequestingAgent(metadata?.requestingAgent) ??
    parseRequestingAgent(rec(metadata?.requestUserApproval)?.requestingAgent)
  );
}

function parseOptions(value: unknown): PinnedQuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((o) => {
    const or = rec(o);
    const label = str(or?.label);
    if (!or || !label) return [];
    return [{ label, description: str(or.description), recommended: or.recommended === true }];
  });
}

export function parsePinnedQuestion(metadata: Message['metadata']): PinnedQuestionDisplay | null {
  const r = rec(metadata?.display);
  if (!r || r.placement !== 'pinned' || r.kind !== 'question') return null;
  // deliver_to 'agent' rows record a question asked of the spawning agent: never pinned.
  if (r.deliver_to !== undefined && r.deliver_to !== 'user') return null;
  const question = str(r.question);
  const questionId = str(r.question_id);
  if (!question || !questionId) return null;
  return {
    placement: 'pinned',
    kind: 'question',
    question,
    options: parseOptions(r.options),
    allow_other: r.allow_other !== false,
    question_id: questionId,
    items: parseFilePointers(r.items),
    routed_agent_id: str(r.routed_agent_id),
  };
}

const TERMINAL_TOOL_STATUSES = new Set(['FINISHED', 'ERROR', 'CANCELLED']);

/**
 * Question ids already answered: a pin row whose lifecycle ended (the backend
 * flips IN_PROGRESS → FINISHED when the answer lands) or that carries the
 * agents worker's `displayAnswer`.
 */
export function answeredQuestionIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const metadata = message.metadata;
    const id = str(rec(metadata?.display)?.question_id);
    if (!id) continue;
    const status = metadata?.toolStatus;
    const ended = typeof status === 'string' && TERMINAL_TOOL_STATUSES.has(status);
    if (ended || metadata?.displayAnswer !== undefined) ids.add(id);
  }
  return ids;
}

/** The fields of GET /api/attention-requests rows the pin reads. */
export interface AttentionRequestLike {
  id: string;
  agent_id: string;
  question: string;
  answered: boolean;
  metadata?: Record<string, unknown> | null;
}

/**
 * A DESCENDANT agent's pinned question from the attention-request list: kind
 * 'question', delivered to the user, routed to `rootAgentId`, and raised by an
 * agent other than the root (the root's own pins come from its messages).
 */
export function parseDescendantPinnedQuestion(
  request: AttentionRequestLike,
  rootAgentId: string,
): { question: PinnedQuestionDisplay; requester: RequestingAgent | null } | null {
  if (request.answered || request.agent_id === rootAgentId) return null;
  const metadata = rec(request.metadata);
  const marker = rec(metadata?.agentTools);
  if (
    !marker ||
    marker.kind !== 'question' ||
    marker.deliverTo !== 'user' ||
    marker.routedAgentId !== rootAgentId
  ) {
    return null;
  }
  const question = str(request.question);
  if (!question) return null;
  const stored = rec(metadata?.displayQuestion);
  return {
    question: {
      placement: 'pinned',
      kind: 'question',
      question,
      options: parseOptions(stored?.options),
      allow_other: stored?.allowOther !== false,
      question_id: request.id,
      items: parseFilePointers(stored?.items),
      routed_agent_id: rootAgentId,
    },
    requester: parseRequestingAgent(metadata?.requestingAgent),
  };
}

/** One inline `display` media item, or null (stock attachment rendering). */
export function parseDisplayMedia(message: Message): DisplayMediaItem | null {
  if (message.role !== 'ASSISTANT' || !message.file_pointer) return null;
  const display = rec(message.metadata?.display);
  if (!display || display.placement !== 'inline' || display.kind !== 'media') return null;
  return {
    file: message.file_pointer,
    mime_type: str(display.mime_type) ?? message.file_pointer.mime_type,
    sha256: str(display.sha256),
    caption: str(display.caption),
    requester: messageRequester(message.metadata),
  };
}

/** HTML media renders in a sandboxed cross-origin frame, never on the app origin. */
export function isHtmlDisplayMedia(item: Pick<DisplayMediaItem, 'mime_type'>): boolean {
  return item.mime_type.split(';')[0].trim().toLowerCase() === 'text/html';
}

export function isSendMessageToUserRow(metadata: Message['metadata']): boolean {
  const toolName = metadata?.toolName;
  return toolName === 'send_message_to_user' || toolName === 'send_message_to_user_execute_phase';
}

/**
 * Rows a code agent addressed to the USER (inline media, send_message_to_user).
 * They carry subAgentId = task (grouped under its chip) but belong in the root
 * trajectory, so "Make me a game" ends with the game on screen.
 */
export function isCodeAgentUserFacingRow(message: Message): boolean {
  if (parseRequestingAgent(message.metadata?.requestingAgent)?.kind !== 'code_agent') return false;
  return isSendMessageToUserRow(message.metadata) || parseDisplayMedia(message) !== null;
}

function parseParty(
  value: unknown,
  fallbackProvider: CodeAgentProvider | null,
): AgentToAgentParty | null {
  const r = rec(value);
  const id = str(r?.id);
  if (!r || !id || (r.kind !== 'agent' && r.kind !== 'code')) return null;
  const rawLabel = str(r.label)?.trim();
  if (r.kind === 'code') {
    const prov = provider(r.provider) ?? fallbackProvider;
    return {
      id,
      kind: 'code',
      provider: prov ?? undefined,
      label: prov ? codeAgentLabel(prov) : (rawLabel ?? 'Code agent'),
    };
  }
  return {
    id,
    kind: 'agent',
    label: !rawLabel || GENERIC_ROSE_LABELS.has(rawLabel) ? 'Rose' : rawLabel,
  };
}

/**
 * Every A2A row carries `a2a.text` = the sender's raw words (backend ea93d584b);
 * the row's own text keeps the LLM framing written by `formatInboundAgentMessage`:
 * "[Message|Question from <label>, agent_id <id>. …]\n\n<text>". Older rows
 * without `a2a.text` fall back to dropping exactly that leading frame.
 */
function senderText(a2a: Rec, message: Message): string {
  const explicit = str(a2a.text);
  if (explicit) return explicit;
  const text = message.text ?? '';
  const frame = /^\[(?:Message|Question) from [^\n]*\]\n\n/.exec(text);
  return frame ? text.slice(frame[0].length) : text;
}

/** Agent-to-agent message carried by this row, or null (stock rendering). */
export function parseAgentToAgentMessage(message: Message): AgentToAgentMessage | null {
  const metadata = message.metadata;
  const a2a = rec(metadata?.a2a);
  if (!a2a) return null;
  const messageId = str(a2a.message_id);
  const codeProvider = provider(metadata?.code_provider);
  const from = parseParty(a2a.from, codeProvider);
  const to = parseParty(a2a.to, codeProvider);
  if (!messageId || !from || !to) return null;
  const direction =
    a2a.direction === 'sent' || a2a.direction === 'received' ? a2a.direction : undefined;
  return {
    kind: a2a.kind === 'question' ? 'question' : 'message',
    direction,
    message_id: messageId,
    from,
    to,
    text: senderText(a2a, message),
  };
}

/** The code agent on either side of an exchange (for its icon), if any. */
export function agentToAgentCodeProvider(a2a: AgentToAgentMessage): CodeAgentProvider | null {
  return a2a.from.provider ?? a2a.to.provider ?? null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

async function postJson(path: string, body: Record<string, string | undefined>): Promise<void> {
  const res = await fetch(`${API_BASE_WITH_PATH}${path}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error || `Request failed (${res.status})`);
  }
}

/** A fresh idempotency key for one direct turn (reuse it when retrying the same text). */
export function newDirectTurnId(): string {
  return `turn-${crypto.randomUUID()}`;
}

/**
 * Send text straight into the code agent's CLI session (backend
 * directChatService). Retrying with the same `clientMessageId` never starts a
 * second CLI turn.
 */
export function sendCodeAgentMessage(args: {
  taskId: string;
  text: string;
  clientMessageId: string;
  toolCallId?: string;
}) {
  return postJson(`/claude-code-session/${encodeURIComponent(args.taskId)}/turns`, {
    client_message_id: args.clientMessageId,
    text: args.text,
    tool_call_id: args.toolCallId,
  });
}

/** The spawn tool call that owns a code task's chip (sent with direct turns). */
export function codeAgentToolCallId(messages: Message[], taskId: string): string | undefined {
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.task_id !== taskId || metadata.toolName !== 'spawn_claude_code_agent') continue;
    const id = str(metadata.toolCallId);
    if (id) return id;
  }
  return undefined;
}

/** A failed answer request; its status drives the card (404 unpins, others keep it). */
export class PinnedQuestionAnswerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PinnedQuestionReply = { answer: string } | { dismiss: true };

/**
 * Answer (option label, or free text when allow_other) or dismiss a pinned
 * question. `agentId` is the pin's own agent or the one it is routed to (the
 * root); the first answer wins and later ones return the stored state.
 */
export async function answerPinnedQuestion(
  agentId: string,
  questionId: string,
  reply: PinnedQuestionReply,
): Promise<void> {
  const path = `/agents/${encodeURIComponent(agentId)}/questions/${encodeURIComponent(questionId)}/answer`;
  const res = await fetch(`${API_BASE_WITH_PATH}${path}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(reply),
  });
  if (res.ok) return;
  const error = (await res.json().catch(() => ({}))) as { error?: string };
  throw new PinnedQuestionAnswerError(res.status, error.error || `Request failed (${res.status})`);
}
