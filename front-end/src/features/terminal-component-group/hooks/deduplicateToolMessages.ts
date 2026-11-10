/**
 * Deduplicates TOOL messages while preserving explore-agent and wait_for step history.
 * Background spawn rows (excludeFromModel) stay visible while the parent keeps
 * thinking (see backgroundSpawnRows.ts).
 */

import { isExplorePlumbingCopy, userFacingMessageText } from '@/lib/userFacingMessage';
import type { Message } from '../api';
import type { ExploreStep, WaitForCheck } from '../types';
import { isInternalLivenessTool, removeCancelledThoughtErrors } from './messageCleanup';
import { deriveExploreStepTitle } from './exploreStepTitles';
import { isBackgroundSpawnRow } from './backgroundSpawnRows';

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

const TERMINAL_TOOL_STATUSES = new Set(['FINISHED', 'ERROR']);

function isTerminalTool(message: Message): boolean {
  return TERMINAL_TOOL_STATUSES.has(String(message.metadata?.toolStatus));
}

/**
 * A chip is identified by its tool call AND the tool that owns it.
 *
 * toolCallId alone is not an identity: more than one writer posts under a
 * failing tool's toolCallId (run_agent's explore error post, and
 * agent_workflow's main-path catch-all), so a plain toolCallId map let one
 * writer's row silently delete another tool's chip. Keying by both means an
 * unrelated writer adds a chip instead of destroying one.
 */
function chipKey(message: Message): string {
  const key = `${String(message.metadata?.toolCallId)}::${String(message.metadata?.toolName ?? '')}`;
  // A woken background task's later run gets its own chip (earlier runs stay as they finished).
  const run = message.metadata?.backgroundRun;
  return typeof run === 'number' && run > 1 ? `${key}::run${run}` : key;
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

    const key = chipKey(message);
    const existing = toolMessageMap.get(key);
    if (existing) {
      const isAttention = !!message.metadata?.isUserAttentionMessage;
      const isWaitFor = message.metadata?.toolName === 'wait_for';
      // Writes can be persisted out of program order (backgrounded posts race),
      // so a late IN_PROGRESS must not resurrect a chip that already finished —
      // that strands a spinner cleanOrphanedInProgress never reaps for explore.
      const wouldUnfinish = isTerminalTool(existing.message) && !isTerminalTool(message);
      toolMessageMap.set(key, {
        message: wouldUnfinish
          ? existing.message
          : isAttention || isWaitFor
            ? { ...message, message_id: existing.message.message_id }
            : message,
        firstTimestamp: existing.firstTimestamp,
      });
    } else {
      toolMessageMap.set(key, {
        message,
        firstTimestamp: message.timestamp,
      });
    }
  });

  const toolMessages = Array.from(toolMessageMap.values()).map(({ message, firstTimestamp }) =>
    message.timestamp === firstTimestamp ? message : { ...message, timestamp: firstTimestamp },
  );

  return { toolMessages, nonToolMessages };
}

function cleanOrphanedInProgress(tools: Message[], lastAssistantTimestamp: number): Message[] {
  return tools.filter((m) => {
    if (m.metadata?.toolStatus !== 'IN_PROGRESS') return true;
    if (m.metadata?.isUserAttentionMessage || m.metadata?.gate) return true;
    if (m.metadata?.agentType === 'explore') return true;
    if (m.metadata?.toolName === 'wait_for') return true;
    // Background spawns keep running while the parent keeps thinking.
    if (isBackgroundSpawnRow(m)) return true;
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
    agentTree: m.metadata?.agentTree,
  };
}

interface ExploreGrouping {
  representatives: Set<string>;
  hidden: Set<string>;
  stepMap: Map<string, ExploreStep[]>;
  dataByTaskId: Map<string, ExploreData>;
  patched: Map<string, Message>;
}

function isThinkingSpawnMessage(m: Message): boolean {
  return m.metadata?.toolName === 'spawn_agent' && m.metadata?.title === 'Explore agent thinking';
}

function isExploreSpawnFinal(message: Message, ownerCallId?: string): boolean {
  if (message.metadata?.toolName !== 'spawn_agent' || isThinkingSpawnMessage(message)) return false;
  if (message.metadata?.toolStatus !== 'FINISHED' && message.metadata?.toolStatus !== 'ERROR') {
    return false;
  }
  if (ownerCallId && message.metadata?.toolCallId !== ownerCallId) return false;
  return true;
}

function resolveExploreChipResult(
  msgs: Message[],
  ownerCallId: string | undefined,
  fallback: string,
): string {
  const spawnFinals = msgs.filter((message) => isExploreSpawnFinal(message, ownerCallId));
  for (const message of [...spawnFinals].reverse()) {
    const visible = userFacingMessageText(message.text);
    if (visible && !isExplorePlumbingCopy(message.text)) return visible;
  }
  return userFacingMessageText(fallback);
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
  const patched = new Map<string, Message>();

  for (const [taskId, msgs] of byTask) {
    msgs.sort(sortByTimestampAsc);
    const isSpawnInitOrFinal = (m: Message) =>
      m.metadata?.toolName === 'spawn_agent' && !isThinkingSpawnMessage(m);
    const firstSpawn = msgs.find(isSpawnInitOrFinal);
    const ownerSpawn =
      msgs.find(
        (m) =>
          isSpawnInitOrFinal(m) && typeof m.metadata?.fullGoal === 'string' && m.metadata.fullGoal,
      ) ||
      msgs.find((m) => isSpawnInitOrFinal(m) && m.metadata?.title === 'Exploring') ||
      firstSpawn;
    const ownerCallId =
      typeof ownerSpawn?.metadata?.toolCallId === 'string'
        ? ownerSpawn.metadata.toolCallId
        : undefined;
    const terminalSpawn = [...msgs].reverse().find((m) => isExploreSpawnFinal(m, ownerCallId));
    const representative = terminalSpawn || firstSpawn || msgs[0];
    const resolvedText = resolveExploreChipResult(msgs, ownerCallId, representative.text || '');
    const viewRep =
      resolvedText === (representative.text || '')
        ? representative
        : { ...representative, text: resolvedText };

    const steps = msgs.filter((m) => m.message_id !== viewRep.message_id).map(buildExploreStep);

    stepMap.set(viewRep.message_id, steps);
    representatives.add(viewRep.message_id);
    patched.set(viewRep.message_id, viewRep);

    dataByTaskId.set(taskId, {
      repMessageId: viewRep.message_id,
      title: (viewRep.metadata?.title as string) || '',
      fullGoal: (viewRep.metadata?.fullGoal as string) || undefined,
      message: resolvedText,
      status: ((viewRep.metadata?.toolStatus as string) || 'IN_PROGRESS') as ExploreData['status'],
      steps,
    });

    for (const m of msgs) {
      if (m.message_id !== viewRep.message_id) {
        hidden.add(m.message_id);
      }
    }
  }

  return { representatives, hidden, stepMap, dataByTaskId, patched };
}

function buildWaitForChecks(
  rawMsgs: Message[],
  dataByTaskId: Map<string, ExploreData>,
  childIds: Set<string>,
): WaitForCheck[] {
  rawMsgs.sort(sortByTimestampAsc);

  const latestByCheckNum = new Map<number, Message>();
  for (const m of rawMsgs.filter((msg) => msg.metadata?.checkNum != null)) {
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

  const withExploreGrouped = withCompressedPlans
    .filter((m) => {
      if (explore.representatives.has(m.message_id)) return true;
      if (explore.hidden.has(m.message_id)) return false;
      return true;
    })
    .map((m) => explore.patched.get(m.message_id) ?? m);

  const waitForCheckMap = new Map<string, WaitForCheck[]>();
  const waitForChildIds = new Set<string>();
  const firstByToolCallId = new Map<unknown, Message>();
  for (const message of withExploreGrouped) {
    const id = message.metadata?.toolCallId;
    if (!firstByToolCallId.has(id)) firstByToolCallId.set(id, message);
  }

  for (const [toolCallId, rawMsgs] of rawWaitForByToolCallId) {
    if (rawMsgs.length <= 1) continue;
    const representative = firstByToolCallId.get(toolCallId);
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
