/** Ordered UI projection only: live comms and work share a single trajectory slot. */
import type { Message } from '../hooks';
import {
  eventTimeMs,
  parseAgentToAgentMessage,
  parsePinnedQuestion,
} from '../hooks/codeAgentContract';

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
  if (
    parsePinnedQuestion(metadata) ||
    message.file_pointer ||
    metadata?.inlineView ||
    metadata?.isUserAttentionMessage ||
    metadata?.isFinalSummary ||
    metadata?.completionSummary ||
    metadata?.toolName === 'spawn_claude_code_agent' ||
    metadata?.toolName === 'set_plan' ||
    metadata?.requestUserApproval ||
    metadata?.error ||
    /failed|error/i.test(String(metadata?.toolStatus ?? ''))
  )
    return null;
  const a2a = parseAgentToAgentMessage(message);
  if (a2a)
    return {
      key: JSON.stringify([a2a.from.id, a2a.to.id, a2a.message_id]),
      message,
      kind: 'comms',
      label: `${a2a.from.label} → ${a2a.to.label} · ${a2a.text}`,
    };
  const tool = metadata?.toolName;
  if (
    message.role !== 'TOOL' ||
    typeof tool !== 'string' ||
    /send_message_to_user|display|request_user|approv|ask_user|phone|payment|connect|credit|attempt_completion/.test(
      tool,
    )
  )
    return null;
  const title =
    typeof metadata?.title === 'string' && metadata.title.trim()
      ? metadata.title
      : tool.replaceAll('_', ' ');
  return {
    key: message.message_id,
    message,
    kind: tool === 'thought' ? 'thinking' : 'work',
    label: title,
  };
}

function outcome(status?: string): TrajectoryWorkGroup['status'] {
  if (status === 'COMPLETED') return 'completed';
  if (status === 'FAILED') return 'failed';
  if (status === 'PAUSED' || status === 'CANCELLED') return 'interrupted';
  return 'running';
}
function at(message: Message) {
  const value = eventTimeMs(message.timestamp);
  return value !== null && value > 0 ? value : null;
}
function groupKey(activity: TrajectoryActivity) {
  const call = activity.message.metadata?.toolCallId;
  return activity.kind === 'comms' ? activity.key : typeof call === 'string' ? call : activity.key;
}

export function groupTrajectoryWork(
  messages: Message[],
  status?: string,
  endedAt?: string,
): TrajectoryWorkGrouping {
  const result: TrajectoryWorkGrouping = { groupsByLeadId: new Map(), foldedIds: new Set() };
  let current: TrajectoryWorkGroup | null = null;
  let turn = 'initial';
  let seen = new Set<string>();
  const canonicalComms = new Set<string>();
  for (const message of messages) {
    const activity = trajectoryActivity(message);
    if (!activity) {
      if (current) {
        current.status =
          message.metadata?.error ||
          /failed|error/i.test(String(message.metadata?.toolStatus ?? ''))
            ? 'failed'
            : 'completed';
        current.endedAt = at(message);
      }
      current = null;
      seen = new Set();
      if (message.role === 'USER') turn = message.message_id;
      continue;
    }
    if (activity.kind === 'comms' && canonicalComms.has(activity.key)) {
      result.foldedIds.add(message.message_id);
      continue;
    }
    if (activity.kind === 'comms') canonicalComms.add(activity.key);
    if (!current) {
      current = {
        key: `${turn}:${groupKey(activity)}`,
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
    current.status = outcome(status);
    if (current.status !== 'running') {
      const end = endedAt ? eventTimeMs(endedAt) : null;
      current.endedAt = end !== null && end >= (current.startedAt ?? 0) ? end : null;
    }
  }
  return result;
}
