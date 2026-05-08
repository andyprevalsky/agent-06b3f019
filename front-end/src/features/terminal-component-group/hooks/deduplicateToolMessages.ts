/**
 * Pure helper that collapses multiple TOOL messages sharing a `toolCallId`
 * into a single representative message, preserves explore-agent / wait_for
 * sub-step history, compresses `set_plan` updates, cleans up orphaned
 * IN_PROGRESS tools, and groups explore-agent messages by `taskId`.
 *
 * Returns a tuple of:
 *   [ ordered messages, exploreStepMap (repId -> steps), waitForCheckMap ]
 * so the caller can render representative messages plus attached history.
 *
 * Lives in the hooks layer (not a separate utils file) so consumers reach it
 * through hooks.ts without the api layer needing to import from a non-layer
 * module — preserving the forward-only dependency chain.
 */

import type { Message } from '../api';
import type { ExploreStep, WaitForCheck } from '../types';

interface ExploreData {
  repMessageId: string;
  title: string;
  fullGoal?: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  steps: ExploreStep[];
}

function sortByTimestampAsc(a: Message, b: Message): number {
  return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}

function isInternalLivenessTool(message: Message): boolean {
  return message.role === 'TOOL' && message.metadata?.toolName === 'agent_init';
}

function collectRawWaitFor(messages: Message[]): Map<string, Message[]> {
  const raw = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.role !== 'TOOL' || m.metadata?.toolName !== 'wait_for') continue;
    const toolCallId = m.metadata?.toolCallId;
    if (!toolCallId) continue;
    const existing = raw.get(toolCallId) || [];
    existing.push(m);
    raw.set(toolCallId, existing);
  }
  return raw;
}

function dedupByToolCallId(messages: Message[]): {
  toolMessages: Message[];
  nonToolMessages: Message[];
} {
  const toolMessageMap = new Map<string, { message: Message; firstTimestamp: string }>();
  const nonToolMessages: Message[] = [];

  messages.forEach((message) => {
    if (message.role !== 'TOOL') {
      nonToolMessages.push(message);
      return;
    }

    const toolCallId = message.metadata?.toolCallId;
    if (!toolCallId) {
      console.error('Tool message missing toolCallId in metadata:', message);
      nonToolMessages.push(message);
      return;
    }

    const existing = toolMessageMap.get(toolCallId);
    if (existing) {
      const isAttention = !!message.metadata?.isUserAttentionMessage;
      const isWaitFor = message.metadata?.toolName === 'wait_for';
      toolMessageMap.set(toolCallId, {
        message:
          isAttention || isWaitFor
            ? { ...message, message_id: existing.message.message_id }
            : message,
        firstTimestamp: existing.firstTimestamp,
      });
    } else {
      toolMessageMap.set(toolCallId, {
        message,
        firstTimestamp: message.timestamp,
      });
    }
  });

  const toolMessages = Array.from(toolMessageMap.values()).map(({ message, firstTimestamp }) => ({
    ...message,
    timestamp: firstTimestamp,
  }));

  return { toolMessages, nonToolMessages };
}

function cleanOrphanedInProgress(tools: Message[], lastAssistantTimestamp: number): Message[] {
  return tools.filter((m) => {
    if (m.metadata?.toolStatus !== 'IN_PROGRESS') return true;
    if (m.metadata?.isUserAttentionMessage) return true;
    if (m.metadata?.agentType === 'explore') return true;
    if (m.metadata?.toolName === 'wait_for') return true;
    const toolTime = new Date(m.timestamp).getTime();
    return toolTime >= lastAssistantTimestamp;
  });
}

function compressSetPlans(tools: Message[]): Message[] {
  const latestSetPlan = tools
    .filter((m) => m.metadata?.toolName === 'set_plan')
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

  return tools.filter(
    (m) => m.metadata?.toolName !== 'set_plan' || m.message_id === latestSetPlan?.message_id,
  );
}

function buildExploreStep(m: Message): ExploreStep {
  const status = (m.metadata?.toolStatus as string) || 'IN_PROGRESS';
  const title = (m.metadata?.title as string) || '';
  const isThinking =
    m.metadata?.toolName === 'spawn_agent' && title === 'Explore agent thinking';
  const message = status === 'IN_PROGRESS' && !isThinking ? '' : m.text || '';
  return {
    title,
    status: status as ExploreStep['status'],
    timestamp: m.timestamp,
    message,
    toolName: (m.metadata?.toolName as string) || '',
  };
}

interface ExploreGrouping {
  representatives: Set<string>;
  hidden: Set<string>;
  stepMap: Map<string, ExploreStep[]>;
  dataByTaskId: Map<string, ExploreData>;
}

function groupExploreMessages(messages: Message[]): ExploreGrouping {
  const byTask = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.metadata?.agentType !== 'explore') continue;
    const taskId = m.metadata?.taskId as string;
    if (!taskId) continue;
    const existing = byTask.get(taskId) || [];
    existing.push(m);
    byTask.set(taskId, existing);
  }

  const representatives = new Set<string>();
  const hidden = new Set<string>();
  const stepMap = new Map<string, ExploreStep[]>();
  const dataByTaskId = new Map<string, ExploreData>();

  for (const [taskId, msgs] of byTask) {
    msgs.sort(sortByTimestampAsc);
    const terminalSpawn = msgs.find(
      (m) =>
        m.metadata?.toolName === 'spawn_agent' &&
        (m.metadata?.toolStatus === 'FINISHED' || m.metadata?.toolStatus === 'ERROR'),
    );
    const firstSpawn = msgs.find((m) => m.metadata?.toolName === 'spawn_agent');
    const representative = terminalSpawn || firstSpawn || msgs[0];

    const steps = msgs
      .filter((m) => m.message_id !== representative.message_id)
      .map(buildExploreStep);

    stepMap.set(representative.message_id, steps);
    representatives.add(representative.message_id);

    dataByTaskId.set(taskId, {
      repMessageId: representative.message_id,
      title: (representative.metadata?.title as string) || '',
      fullGoal: (representative.metadata?.data as { goal?: string } | undefined)?.goal ?? undefined,
      message: representative.text || '',
      status: ((representative.metadata?.toolStatus as string) || 'IN_PROGRESS') as
        | 'IN_PROGRESS'
        | 'FINISHED'
        | 'ERROR',
      steps,
    });

    for (const m of msgs) {
      if (m.message_id !== representative.message_id) {
        hidden.add(m.message_id);
      }
    }
  }

  return { representatives, hidden, stepMap, dataByTaskId };
}

function buildWaitForChecks(
  rawMsgs: Message[],
  dataByTaskId: Map<string, ExploreData>,
  childIds: Set<string>,
): WaitForCheck[] {
  rawMsgs.sort(sortByTimestampAsc);
  const withCheckNum = rawMsgs.filter((m) => m.metadata?.checkNum != null);

  const latestByCheckNum = new Map<number, Message>();
  for (const m of withCheckNum) {
    latestByCheckNum.set(m.metadata!.checkNum as number, m);
  }

  return Array.from(latestByCheckNum.values()).map((m) => {
    const exploreTaskId = m.metadata?.exploreTaskId as string | undefined;
    let explore: WaitForCheck['explore'];
    if (exploreTaskId) {
      const data = dataByTaskId.get(exploreTaskId);
      if (data) {
        childIds.add(data.repMessageId);
        explore = {
          title: data.title,
          fullGoal: data.fullGoal,
          message: data.message,
          status: data.status,
          steps: data.steps,
        };
      }
    }
    return {
      title: (m.metadata?.title as string) || '',
      status: ((m.metadata?.toolStatus as string) || 'IN_PROGRESS') as WaitForCheck['status'],
      timestamp: m.timestamp,
      message: m.text || '',
      checkNum: m.metadata?.checkNum as number | undefined,
      maxChecks: m.metadata?.maxChecks as number | undefined,
      conditionMet: m.metadata?.conditionMet as boolean | undefined,
      exploreTaskId,
      explore,
    };
  });
}

export function deduplicateToolMessages(
  messages: Message[],
): [Message[], Map<string, ExploreStep[]>, Map<string, WaitForCheck[]>] {
  const sortedMessages = messages
    .filter((m) => !isInternalLivenessTool(m))
    .sort(sortByTimestampAsc);

  const lastAssistantTimestamp =
    sortedMessages
      .filter((m) => m.role === 'ASSISTANT' && m.text?.trim() && m.metadata?.dagTaskIndex == null)
      .map((m) => new Date(m.timestamp).getTime())
      .pop() ?? 0;

  const rawWaitForByToolCallId = collectRawWaitFor(sortedMessages);
  const { toolMessages, nonToolMessages } = dedupByToolCallId(sortedMessages);
  const cleanedTools = cleanOrphanedInProgress(toolMessages, lastAssistantTimestamp);
  const withCompressedPlans = compressSetPlans(cleanedTools);

  const explore = groupExploreMessages(withCompressedPlans);

  const withExploreGrouped = withCompressedPlans.filter((m) => {
    if (explore.representatives.has(m.message_id)) return true;
    if (explore.hidden.has(m.message_id)) return false;
    return true;
  });

  const waitForCheckMap = new Map<string, WaitForCheck[]>();
  const waitForChildIds = new Set<string>();

  for (const [toolCallId, rawMsgs] of rawWaitForByToolCallId) {
    if (rawMsgs.length <= 1) continue;
    const representative = withExploreGrouped.find((m) => m.metadata?.toolCallId === toolCallId);
    if (!representative) continue;

    const checks = buildWaitForChecks(rawMsgs, explore.dataByTaskId, waitForChildIds);
    waitForCheckMap.set(representative.message_id, checks);
  }

  const withWaitForChildrenHidden = withExploreGrouped.filter(
    (m) => !waitForChildIds.has(m.message_id),
  );

  const deduplicatedMessages = [...nonToolMessages, ...withWaitForChildrenHidden];
  deduplicatedMessages.sort(sortByTimestampAsc);

  return [deduplicatedMessages, explore.stepMap, waitForCheckMap];
}
