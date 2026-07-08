/** Deduplicates TOOL messages while preserving explore-agent and wait_for step history. */

import type { Message } from '../api';
import type { ExploreStep, WaitForCheck } from '../types';
import { isInternalLivenessTool, removeCancelledThoughtErrors } from './messageCleanup';
import { extractLineValue, extractMarkdownParam } from './messageTextParsing';

interface ExploreData {
  repMessageId: string;
  title: string;
  fullGoal?: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  steps: ExploreStep[];
}

function getMessageOrderTimestamp(message: Message): number {
  const metadata = message.metadata;
  const firstTimestamp =
    typeof metadata?.firstTimestamp === 'string'
      ? metadata.firstTimestamp
      : typeof metadata?.startedAt === 'string' && metadata?.plannedToolName === 'reasoning'
        ? metadata.startedAt
        : message.timestamp;
  const orderedMs = new Date(firstTimestamp).getTime();
  if (Number.isFinite(orderedMs)) return orderedMs;
  return new Date(message.timestamp).getTime();
}

function sortByTimestampAsc(a: Message, b: Message): number {
  return getMessageOrderTimestamp(a) - getMessageOrderTimestamp(b);
}

function formatWebSearchTitle(rawTitle: string, status: ExploreStep['status'], query: string | undefined): string {
  if (!query) return rawTitle;
  if (
    rawTitle !== 'Searching the web' &&
    rawTitle !== 'Web search completed' &&
    rawTitle !== '❌ Web search failed'
  ) {
    return rawTitle;
  }

  if (status === 'ERROR') return `Web search failed for ${query}`;
  if (status === 'FINISHED') return `Searched the web for ${query}`;
  return `Searching the web for ${query}`;
}

function formatWebFetchTitle(rawTitle: string, status: ExploreStep['status'], text: string): string {
  if (
    rawTitle !== 'Fetching web content' &&
    rawTitle !== 'Web fetch complete' &&
    rawTitle !== '❌ Web fetch failed'
  ) {
    return rawTitle;
  }

  const activeMatch = text.match(/^Extracting from\s+([^:]+):\s*(.+)$/im);
  const url = activeMatch?.[1]?.trim() || extractMarkdownParam(text, 'url');
  const objective = activeMatch?.[2]?.trim() || extractMarkdownParam(text, 'objective');
  if (!url && !objective) return rawTitle;

  const target = [url, objective ? `for ${objective}` : ''].filter(Boolean).join(' ');
  if (status === 'ERROR') return `Web fetch failed for ${target}`;
  if (status === 'FINISHED') return `Fetched ${target}`;
  return `Fetching ${target}`;
}

function deriveExploreStepTitle(m: Message, status: ExploreStep['status']): string {
  const rawTitle = ((m.metadata?.title as string) || '').trim();
  const text = m.text || '';
  const toolName = (m.metadata?.toolName as string) || '';

  if (toolName === 'web_search') {
    const query =
      typeof m.metadata?.query === 'string'
        ? m.metadata.query
        : extractLineValue(text, 'Query') || extractMarkdownParam(text, 'query');
    return formatWebSearchTitle(rawTitle, status, query);
  }

  if (toolName === 'web_fetch') {
    return formatWebFetchTitle(rawTitle, status, text);
  }

  return rawTitle;
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

function dedupByToolCallId(messages: Message[]): { toolMessages: Message[]; nonToolMessages: Message[] } {
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
    if (m.metadata?.isUserAttentionMessage || m.metadata?.gate) return true;
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
  const normalizedStatus = status as ExploreStep['status'];
  const title = deriveExploreStepTitle(m, normalizedStatus);
  const isThinking = m.metadata?.toolName === 'spawn_agent' && title === 'Explore agent thinking';
  const message = status === 'IN_PROGRESS' && !isThinking ? '' : m.text || '';
  return {
    title,
    status: normalizedStatus,
    timestamp: m.timestamp,
    message,
    toolName: (m.metadata?.toolName as string) || '',
    toolCallId: (m.metadata?.toolCallId as string) || undefined,
  };
}

interface ExploreGrouping {
  representatives: Set<string>;
  hidden: Set<string>;
  stepMap: Map<string, ExploreStep[]>;
  dataByTaskId: Map<string, ExploreData>;
}

function isThinkingSpawnMessage(m: Message): boolean {
  return m.metadata?.toolName === 'spawn_agent' && m.metadata?.title === 'Explore agent thinking';
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
    const isSpawnInitOrFinal = (m: Message) =>
      m.metadata?.toolName === 'spawn_agent' && !isThinkingSpawnMessage(m);
    const terminalSpawn = msgs.find(
      (m) =>
        isSpawnInitOrFinal(m) &&
        (m.metadata?.toolStatus === 'FINISHED' || m.metadata?.toolStatus === 'ERROR'),
    );
    const firstSpawn = msgs.find(isSpawnInitOrFinal);
    const representative = terminalSpawn || firstSpawn || msgs[0];

    const steps = msgs
      .filter((m) => m.message_id !== representative.message_id)
      .map(buildExploreStep);

    stepMap.set(representative.message_id, steps);
    representatives.add(representative.message_id);

    dataByTaskId.set(taskId, {
      repMessageId: representative.message_id,
      title: (representative.metadata?.title as string) || '',
      fullGoal: (representative.metadata?.fullGoal as string) || undefined,
      message: representative.text || '',
      status: ((representative.metadata?.toolStatus as string) || 'IN_PROGRESS') as ExploreData['status'],
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
  const withoutCancelledThoughts = removeCancelledThoughtErrors(toolMessages);
  const cleanedTools = cleanOrphanedInProgress(withoutCancelledThoughts, lastAssistantTimestamp);
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
