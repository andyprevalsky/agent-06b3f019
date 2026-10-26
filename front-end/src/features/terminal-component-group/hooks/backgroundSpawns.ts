/**
 * Background spawn derivation (spawn_agent `run_in_background`).
 *
 * Every background spawn is identified by its ORIGINAL tool call id ("owner").
 * Its rows are:
 *   - the hidden model-facing "Started … in background" row
 *     (metadata.runInBackground, backgroundAddress/Path/Goal/AgentType)
 *   - UI rows in main's shapes under `<owner>` / `<owner>:<idx>` (for_each
 *     children) with `excludeFromModel`
 *   - one completion row (agentNotification, backgroundTaskId = owner)
 *   - a finished explore/browser/code task woken by an agent message runs again
 *     under the same owner: its rows carry `backgroundRun` (2, 3, …)
 *
 * STATE per spawn (derived, never stored):
 * [RUNNING] -- completion row OR terminal `<owner>` spawn row --> [COMPLETED | FAILED]
 * [ANY] -- completion row with status "paused" --> [PAUSED]
 *          (a user pause ended a browser/code run; resumable, never failed)
 * [COMPLETED | FAILED | PAUSED] -- row with a higher backgroundRun --> [RUNNING]
 *
 * The trajectory renders these rows with main's spawn UI unchanged; the
 * query-box dock reads this derivation (spawned agent ids, for_each groups,
 * in-activity explore/browser/code tasks).
 */
import { isAgentNotificationMetadata } from '@/lib/realtime-types';
import type { Message } from '../api';
import { codexPayload, completionStatus } from './codexMessage';

export type BackgroundRunState = 'running' | 'completed' | 'failed' | 'paused';

export interface BackgroundSpawn {
  ownerToolCallId: string;
  /** general_purpose | for_each | explore | browser | code | agent */
  agentType: string;
  /** Agent id (general_purpose) or task address; null until known. */
  address: string | null;
  /** Codex-style tree path (`/root/outreach/draft_a`) when the backend sends one. */
  path: string | null;
  goal: string;
  /** Output schema passed to spawn_agent when a row carries it (raw; normalized by the chip). */
  outputSchema: unknown;
  state: BackgroundRunState;
  /** Raw notification status (e.g. "completed", "cancelled"). */
  rawStatus: string | null;
  subAgentIds: string[];
  busId: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Latest in-progress row title/text (explore/browser/code activity). */
  activity: string | null;
  /** Notification body or terminal row text once finished. */
  resultSummary: string | null;
  /** for_each child rows: total / terminal / failed. */
  childTotal: number;
  childDone: number;
  childFailed: number;
  /** Run of the task (1, or 2+ after a message woke the finished task). */
  run: number;
}

const SPAWN_TOOL_NAMES = new Set([
  'spawn_agent',
  'spawn_general_purpose_agent',
  'spawn_general_purpose_agent_for_each',
  'spawn_sub_agent',
  'spawn_browser_agent',
  'spawn_browser_agent_v3',
  'spawn_claude_code_agent',
]);

const FAILED_STATUSES = new Set([
  'failed',
  'error',
  'cancelled',
  'canceled',
  'timeout',
  'timed_out',
]);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Last path segment of a Codex-style address (`/root/a/b` → `b`); null otherwise. */
export function agentPathShortName(path: string | null | undefined): string | null {
  if (!path || !path.includes('/')) return null;
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/**
 * Human summary of a notification body: drops the machine sections
 * ("Structured Response: {...}", "File: {...}") that the chip renders against
 * the output schema instead.
 */
export function notificationSummary(body: string): string | null {
  const sections = body
    .split(/\n{2,}/)
    .filter((section) => !/^(Structured Response|File):\s/.test(section.trim()));
  const text = sections.join('\n\n').trim();
  return text || null;
}

function baseCallId(toolCallId: unknown): string | null {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return null;
  const colon = toolCallId.indexOf(':');
  return colon === -1 ? toolCallId : toolCallId.slice(0, colon);
}

/**
 * Owner that a row announces by itself: the hidden model-facing "Started…"
 * row (runInBackground), or a UI row posted under the original toolCallId
 * with `excludeFromModel` by a spawn tool.
 */
function announcedOwner(message: Message): string | null {
  if (message.role !== 'TOOL') return null;
  const metadata = message.metadata ?? {};
  const base = baseCallId(metadata.toolCallId);
  if (!base) return null;
  if (metadata.runInBackground === true) return base;
  const toolName = String(metadata.toolName ?? '');
  if (metadata.excludeFromModel === true && toolName.startsWith('spawn_')) return base;
  return null;
}

function ownerOf(message: Message, owners: ReadonlySet<string>): string | null {
  const metadata = message.metadata ?? {};
  if (message.role === 'TOOL') {
    const announced = announcedOwner(message);
    if (announced) return announced;
    const base = baseCallId(metadata.toolCallId);
    return base && owners.has(base) ? base : null;
  }
  if (isAgentNotificationMetadata(message.metadata)) {
    const id = metadata.backgroundTaskId;
    const owner = baseCallId(id);
    return owner && owners.has(owner) ? owner : null;
  }
  return null;
}

function inferAgentType(message: Message): string | null {
  const metadata = message.metadata ?? {};
  const explicit = str(metadata.backgroundAgentType) ?? str(metadata.agentType);
  if (explicit) return explicit;
  const toolName = str(metadata.toolName);
  if (toolName === 'spawn_general_purpose_agent_for_each') return 'for_each';
  if (toolName === 'spawn_general_purpose_agent' || toolName === 'spawn_sub_agent') {
    return 'general_purpose';
  }
  if (toolName?.startsWith('spawn_browser_agent')) return 'browser';
  if (toolName === 'spawn_claude_code_agent') return 'code';
  return null;
}

function isTerminalSpawnRow(message: Message, ownerToolCallId: string): boolean {
  const metadata = message.metadata ?? {};
  if (message.role !== 'TOOL' || metadata.toolCallId !== ownerToolCallId) return false;
  if (metadata.subAgentId || metadata.title === 'Explore agent thinking') return false;
  if (!SPAWN_TOOL_NAMES.has(String(metadata.toolName ?? ''))) return false;
  return metadata.toolStatus === 'FINISHED' || metadata.toolStatus === 'ERROR';
}

/** The workflow's own outcome; "paused" is resumable, so it is neither failed nor completed. */
function notificationState(status: string | null): BackgroundRunState {
  const normalized = status?.toLowerCase() ?? '';
  if (normalized === 'paused') return 'paused';
  return FAILED_STATUSES.has(normalized) ? 'failed' : 'completed';
}

function emptySpawn(owner: string, startedAt: string): BackgroundSpawn {
  return {
    ownerToolCallId: owner,
    agentType: 'agent',
    address: null,
    path: null,
    goal: '',
    outputSchema: null,
    state: 'running',
    rawStatus: null,
    subAgentIds: [],
    busId: null,
    startedAt,
    finishedAt: null,
    activity: null,
    resultSummary: null,
    childTotal: 0,
    childDone: 0,
    childFailed: 0,
    run: 1,
  };
}

/** A row of a later run of a woken task restarts the spawn's derived state. */
function absorbRun(spawn: BackgroundSpawn, message: Message): void {
  const run = message.metadata?.backgroundRun;
  if (typeof run !== 'number' || run <= spawn.run) return;
  spawn.run = run;
  spawn.state = 'running';
  spawn.rawStatus = null;
  spawn.finishedAt = null;
  spawn.resultSummary = null;
  spawn.activity = null;
}

function absorbMetadata(spawn: BackgroundSpawn, message: Message): void {
  const metadata = message.metadata ?? {};
  const type = inferAgentType(message);
  if (type && (spawn.agentType === 'agent' || str(metadata.backgroundAgentType))) {
    spawn.agentType = type;
  }
  spawn.address = spawn.address ?? str(metadata.backgroundAddress);
  const address = str(metadata.backgroundAddress);
  spawn.path =
    spawn.path ??
    str(metadata.backgroundPath) ??
    str(metadata.taskPath) ??
    str(metadata.agentPath) ??
    (address?.startsWith('/') ? address : null);
  spawn.goal =
    spawn.goal ||
    (str(metadata.backgroundGoal) ?? str(metadata.fullGoal) ?? str(metadata.goal) ?? '');
  spawn.busId = spawn.busId ?? str(metadata.busId);
  spawn.outputSchema =
    spawn.outputSchema ??
    metadata.backgroundOutputSchema ??
    metadata.outputSchema ??
    metadata.output_schema ??
    null;
  const ids = Array.isArray(metadata.subAgentIds) ? [...metadata.subAgentIds] : [];
  // "Sub-agent starting" rows name the spawned agent before subAgentIds arrive.
  if (
    metadata.toolName === 'spawn_general_purpose_agent' &&
    typeof metadata.subAgentId === 'string'
  ) {
    ids.push(metadata.subAgentId);
  }
  for (const id of ids) {
    if (typeof id === 'string' && !spawn.subAgentIds.includes(id)) spawn.subAgentIds.push(id);
  }
}

function absorbNotification(spawn: BackgroundSpawn, message: Message): void {
  const metadata = message.metadata ?? {};
  const status = completionStatus(metadata);
  const fromAddress = str(metadata.fromAgentPath) ?? str(metadata.fromAgentAddress);
  spawn.rawStatus = status;
  spawn.state = notificationState(status);
  spawn.finishedAt = message.timestamp;
  spawn.resultSummary = notificationSummary(codexPayload(message.text));
  if (fromAddress?.startsWith('/')) spawn.path = spawn.path ?? fromAddress;
  else spawn.address = spawn.address ?? fromAddress;
  const type = str(metadata.agentType);
  if (type && spawn.agentType === 'agent') spawn.agentType = type;
}

function absorbToolRow(spawn: BackgroundSpawn, message: Message, children: Map<string, string>) {
  absorbMetadata(spawn, message);
  const metadata = message.metadata ?? {};
  const toolCallId = String(metadata.toolCallId ?? '');
  const status = String(metadata.toolStatus ?? '');
  const isChildRow = toolCallId.startsWith(`${spawn.ownerToolCallId}:`);
  if (isChildRow && !metadata.subAgentId) {
    children.set(toolCallId, status);
  }
  if (metadata.runInBackground === true) return;
  const isTerminal = isTerminalSpawnRow(message, spawn.ownerToolCallId);
  if (spawn.state === 'running' && isTerminal) {
    spawn.state = status === 'ERROR' ? 'failed' : 'completed';
    spawn.finishedAt = message.timestamp;
    spawn.resultSummary = spawn.resultSummary ?? (message.text.trim() || null);
  } else if (status === 'IN_PROGRESS') {
    const title = str(metadata.title);
    const text = message.text.trim();
    spawn.activity = title && text && title !== text ? `${title}: ${text}` : title || text || null;
  }
}

function timestampMs(message: Message): number {
  const ms = new Date(message.timestamp).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Derive every background spawn in a transcript, keyed by owner tool call id. */
export function deriveBackgroundSpawns(messages: Message[]): Map<string, BackgroundSpawn> {
  const spawns = new Map<string, BackgroundSpawn>();
  const childStatuses = new Map<string, Map<string, string>>();
  const ordered = [...messages].sort((a, b) => timestampMs(a) - timestampMs(b));
  const owners = new Set<string>();
  for (const message of ordered) {
    const announced = announcedOwner(message);
    if (announced) owners.add(announced);
  }
  for (const message of ordered) {
    const owner = ownerOf(message, owners);
    if (!owner) continue;
    let spawn = spawns.get(owner);
    if (!spawn) {
      spawn = emptySpawn(owner, message.timestamp);
      spawns.set(owner, spawn);
      childStatuses.set(owner, new Map());
    }
    absorbRun(spawn, message);
    if (message.role !== 'TOOL') absorbNotification(spawn, message);
    else absorbToolRow(spawn, message, childStatuses.get(owner)!);
  }
  for (const [owner, spawn] of spawns) {
    const statuses = [...(childStatuses.get(owner)?.values() ?? [])];
    spawn.childTotal = Math.max(
      statuses.length,
      spawn.agentType === 'for_each' ? spawn.subAgentIds.length : 0,
    );
    spawn.childDone = statuses.filter((s) => s === 'FINISHED' || s === 'ERROR').length;
    spawn.childFailed = statuses.filter((s) => s === 'ERROR').length;
    // Older rows address a general-purpose child by its agent id (newer: a path).
    const addressIsAgentId = spawn.address !== null && !spawn.address.startsWith('/');
    if (spawn.agentType === 'general_purpose' && addressIsAgentId && !spawn.subAgentIds.length) {
      spawn.subAgentIds.push(spawn.address!);
    }
  }
  return spawns;
}
