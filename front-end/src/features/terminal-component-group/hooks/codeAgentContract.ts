/**
 * Code-agent steering contract (Rose Desktop, UI ledger rows 44-47 and 51).
 *
 * The ONE adapter between the backend and the code-agent steering UI. The
 * backend side is not merged yet, so every wire shape the UI reads or writes
 * lives here: change this file (and its blackbox fixtures) when the contract
 * moves, and nothing else.
 *
 *   agent:<rootId> realtime INSERT (existing message path)
 *     ├─ metadata.code_agent            → CodeAgentMeta    (chip lifecycle, target, summary)
 *     ├─ metadata.code_agent_events[]   → transcript events (task-scoped rows, hidden from root)
 *     ├─ metadata.from_code_agent       → sender attribution (send_message_to_user / approvals / questions)
 *     ├─ metadata.inlineView (no versionId, view 'scorecard') → host scorecard view
 *     ├─ metadata.display (placement 'pinned', kind 'question') → pinned question
 *     └─ metadata.question_answer       → question answered (unpins everywhere)
 *   POST /api/agents/:id/code-agent/:taskId/messages {text}     → steer the CLI session
 *   POST /api/agents/:id/questions/:questionId/answer {answer}  → answer a pinned question
 *
 * Everything is parsed defensively: a missing or malformed field yields null so
 * the existing chip / bubble behavior stays in charge.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from '@/lib/api/client';
import type { Message } from '@/lib/api/types';

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

/** One entry of `message.metadata.code_agent_events[]`. */
export interface CodeAgentTranscriptEvent {
  type: 'thinking' | 'message' | 'tool';
  /** ISO-8601 or epoch ms. */
  ts: string | number;
  text?: string;
  tool?: CodeAgentToolCall;
  /** 'user' = a steering message echoed back by the session (default 'assistant'). */
  role?: 'assistant' | 'user';
}

/** `message.metadata.from_code_agent` — which code agent produced this row. */
export interface CodeAgentSender {
  provider: CodeAgentProvider;
  task_id?: string;
}

export interface PinnedQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** `message.metadata.display` for a pinned question. */
export interface PinnedQuestionDisplay {
  placement: 'pinned';
  kind: 'question';
  question: string;
  options: PinnedQuestionOption[];
  allow_other: boolean;
  question_id: string;
}

export type ScorecardTone = 'pass' | 'fail' | 'warn' | 'info';

export interface ScorecardRow {
  label: string;
  value: string;
  tone?: ScorecardTone;
}

/** Host-rendered `inlineView` ({ view: 'scorecard', props }) — no versionId. */
export interface ScorecardInlineView {
  title?: string;
  rows: ScorecardRow[];
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
    state,
    started_at: startedAt,
    ended_at: time(r.ended_at),
    failure_message: str(r.failure_message),
    failure_kind: failureKind,
    title: str(r.title),
    summary: parseSummary(r.summary),
  };
}

/** Latest `code_agent` snapshot for one task (later messages win). */
export function latestCodeAgentMeta(messages: Message[], taskId: string): CodeAgentMeta | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = parseCodeAgentMeta(messages[i]?.metadata?.code_agent);
    if (meta && meta.task_id === taskId) return meta;
  }
  return null;
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

export function parseCodeAgentSender(metadata: Message['metadata']): CodeAgentSender | null {
  const r = rec(metadata?.from_code_agent);
  const prov = provider(r?.provider);
  if (!r || !prov) return null;
  return { provider: prov, task_id: str(r.task_id) };
}

export function parsePinnedQuestion(metadata: Message['metadata']): PinnedQuestionDisplay | null {
  const r = rec(metadata?.display);
  if (!r || r.placement !== 'pinned' || r.kind !== 'question') return null;
  const question = str(r.question);
  const questionId = str(r.question_id);
  if (!question || !questionId) return null;
  const options = Array.isArray(r.options)
    ? r.options.flatMap((o) => {
        const or = rec(o);
        const label = str(or?.label);
        if (!or || !label) return [];
        return [{ label, description: str(or.description), recommended: or.recommended === true }];
      })
    : [];
  return {
    placement: 'pinned',
    kind: 'question',
    question,
    options,
    allow_other: r.allow_other !== false,
    question_id: questionId,
  };
}

/** Question ids answered durably (`metadata.question_answer.question_id`). */
export function answeredQuestionIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const id = str(rec(message.metadata?.question_answer)?.question_id);
    if (id) ids.add(id);
  }
  return ids;
}

const TONES: readonly ScorecardTone[] = ['pass', 'fail', 'warn', 'info'];

/**
 * Host scorecard view: `inlineView: { view: 'scorecard', props: { title?, rows } }`
 * WITHOUT a versionId (a versionId pins a user-published iframe view instead).
 */
export function parseScorecardInlineView(value: unknown): ScorecardInlineView | null {
  const r = rec(value);
  if (!r || r.view !== 'scorecard' || r.versionId !== undefined) return null;
  const props = rec(r.props);
  if (!props || !Array.isArray(props.rows)) return null;
  const rows = props.rows.flatMap((row) => {
    const rr = rec(row);
    const label = str(rr?.label);
    if (!rr || !label) return [];
    const value = typeof rr.value === 'number' ? String(rr.value) : (str(rr.value) ?? '');
    return [{ label, value, tone: TONES.find((t) => t === rr.tone) }];
  });
  if (rows.length === 0) return null;
  return { title: str(props.title), rows };
}

// ── Writes ──────────────────────────────────────────────────────────────────

async function postJson(path: string, body: Record<string, string>): Promise<void> {
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

/** Send text straight into the code agent's CLI session. */
export function sendCodeAgentMessage(agentId: string, taskId: string, text: string) {
  return postJson(
    `/agents/${encodeURIComponent(agentId)}/code-agent/${encodeURIComponent(taskId)}/messages`,
    { text },
  );
}

/** Answer a pinned question (option label or free text). */
export function answerPinnedQuestion(agentId: string, questionId: string, answer: string) {
  return postJson(
    `/agents/${encodeURIComponent(agentId)}/questions/${encodeURIComponent(questionId)}/answer`,
    { answer },
  );
}
