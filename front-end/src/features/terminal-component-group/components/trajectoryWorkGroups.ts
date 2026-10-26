/** Ordered UI projection only: live comms and work share a single trajectory slot. */
import type { Message } from '../hooks';
import { isUserFacingWorkBoundary } from './trajectoryUserFacingBoundary';
import { isHiddenTrajectoryRow } from './trajectoryRowVisibility';
import { eventTimeMs, parseAgentToAgentMessage } from '../hooks/codeAgentContract';

export interface TrajectoryActivity {
  key: string;
  message: Message;
  label: string;
  kind: 'comms' | 'work' | 'thinking';
}
export interface TrajectoryWorkGroup {
  key: string;
  leadId: string;
  activities: TrajectoryActivity[];
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  startedAt: number | null;
  endedAt: number | null;
}
export interface TrajectoryWorkGrouping {
  groupsByLeadId: Map<string, TrajectoryWorkGroup>;
  foldedIds: Set<string>;
}

export function trajectoryActivity(message: Message): TrajectoryActivity | null {
  const metadata = message.metadata;
  if (isUserFacingWorkBoundary(message)) return null;
  const a2a = parseAgentToAgentMessage(message);
  if (a2a)
    return {
      key: JSON.stringify([a2a.from.id, a2a.to.id, a2a.message_id]),
      message,
      kind: 'comms',
      label: `${a2a.from.label} → ${a2a.to.label} · ${a2a.text}`,
    };
  // The message renderer displays plain assistant text as a synthetic Thought card.
  if (message.role === 'ASSISTANT' && message.text.trim())
    return { key: message.message_id, message, kind: 'thinking', label: 'Thinking' };
  const tool = metadata?.toolName;
  if (message.role !== 'TOOL') return null;
  const title =
    typeof metadata?.title === 'string' && metadata.title.trim()
      ? metadata.title
      : typeof tool === 'string'
        ? tool.replaceAll('_', ' ')
        : 'Tool result';
  return {
    key: message.message_id,
    message,
    kind: tool === 'thought' ? 'thinking' : 'work',
    label: title,
  };
}

function hasWorkFailure(activities: TrajectoryActivity[]): boolean {
  return activities.some(
    ({ message }) =>
      message.metadata?.error || /failed|error/i.test(String(message.metadata?.toolStatus ?? '')),
  );
}

function outcome(
  status: string | undefined,
  activities: TrajectoryActivity[],
): TrajectoryWorkGroup['status'] {
  if (status === 'COMPLETED') return 'completed';
  if (status === 'FAILED') return hasWorkFailure(activities) ? 'failed' : 'completed';
  if (status === 'PAUSED' || status === 'CANCELLED') return 'interrupted';
  return 'running';
}
function at(message: Message) {
  const value = eventTimeMs(message.timestamp);
  return value !== null && value > 0 ? value : null;
}
/** Stable across a live placeholder being replaced by its persisted row (same instance). */
function groupKey(activity: TrajectoryActivity, ordinal: number) {
  const call = activity.message.metadata?.toolCallId;
  if (activity.kind === 'comms') return activity.key;
  if (typeof call === 'string') return call;
  // A streaming thought has no persisted id yet; its batch keeps its place in the turn.
  return activity.kind === 'thinking' ? `thinking:${ordinal}` : activity.key;
}

export function groupTrajectoryWork(
  messages: Message[],
  status?: string,
  endedAt?: string,
): TrajectoryWorkGrouping {
  const result: TrajectoryWorkGrouping = { groupsByLeadId: new Map(), foldedIds: new Set() };
  let current: TrajectoryWorkGroup | null = null;
  let turn = 'initial';
  let ordinal = 0;
  let seen = new Set<string>();
  const canonicalComms = new Set<string>();
  for (const message of messages) {
    if (isHiddenTrajectoryRow(message)) {
      result.foldedIds.add(message.message_id);
      continue;
    }
    const activity = trajectoryActivity(message);
    if (!activity) {
      if (current) {
        const failedEnd =
          status === 'FAILED' ||
          message.metadata?.error ||
          /failed|error/i.test(String(message.metadata?.toolStatus ?? ''));
        current.status = hasWorkFailure(current.activities) && failedEnd ? 'failed' : 'completed';
        current.endedAt = at(message);
      }
      current = null;
      seen = new Set();
      if (message.role === 'USER') {
        turn = message.message_id;
        ordinal = 0;
      }
      continue;
    }
    if (activity.kind === 'comms' && canonicalComms.has(activity.key)) {
      result.foldedIds.add(message.message_id);
      continue;
    }
    if (activity.kind === 'comms') canonicalComms.add(activity.key);
    if (!current) {
      current = {
        key: `${turn}:${groupKey(activity, ordinal++)}`,
        leadId: message.message_id,
        activities: [],
        status: 'running',
        startedAt: at(message),
        endedAt: null,
      };
      result.groupsByLeadId.set(message.message_id, current);
    }
    result.foldedIds.add(message.message_id);
    if (!seen.has(activity.key)) {
      current.activities.push(activity);
      seen.add(activity.key);
    }
  }
  if (current) {
    current.status = outcome(status, current.activities);
    if (current.status !== 'running') {
      const end = endedAt ? eventTimeMs(endedAt) : null;
      current.endedAt = end !== null && end >= (current.startedAt ?? 0) ? end : null;
    }
  }
  return result;
}
