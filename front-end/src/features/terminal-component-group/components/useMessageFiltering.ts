/**
 * Pure-data hooks for MessageList — filter, dedupe, stream-state memoization,
 * and sub-agent-tree merge. Split out so behavioral hooks (animation buffer,
 * thinking visibility, auto-scroll) can live in useMessageList.ts while the
 * data pipeline lives here.
 *
 * SUB-AGENT MERGE STATES:
 * [RAW SPAWN ROWS] -> group by for_each/base tool call -> [ONE TREE PER CALL]
 * [FOR_EACH TERMINAL] -> infer child ids from child rows -> [AGGREGATE TREE]
 * [NO TERMINAL YET] -> keep live child tree rows visible
 */
import { useMemo, useRef } from 'react';
import {
  deduplicateToolMessages,
  type Message,
  type StreamingAttention,
  type StreamingBubble,
  type StreamingPlan,
  type StreamingTool,
} from '../hooks';
import type { ExploreStep, WaitForCheck } from '../types';

const GENERAL_PURPOSE_AGENT_TOOLS = new Set([
  'spawn_general_purpose_agent',
  'spawn_general_purpose_agent_for_each',
  'spawn_sub_agent',
]);

// ─── Filter messages by subAgentId ───────────────────────────────────────

function filterMessagesForSubAgent(messages: Message[], subAgentId: string | undefined): Message[] {
  const target = subAgentId ?? null;
  return messages.filter((m) => {
    const msgSub = m.metadata?.subAgentId ?? null;
    if (target === null) {
      if (msgSub === null) return true;
      if (m.metadata?.agentType === 'explore') return true;
      return false;
    }
    return msgSub === target;
  });
}

export interface FilteredMessages {
  filteredMessagesRaw: Message[];
  exploreStepMap: Map<string, ExploreStep[]>;
  waitForCheckMap: Map<string, WaitForCheck[]>;
}

export function useFilteredMessages(
  messages: Message[],
  subAgentId: string | undefined,
): FilteredMessages {
  return useMemo(() => {
    const filtered = filterMessagesForSubAgent(messages, subAgentId);
    const withoutSystem = filtered.filter((m) => m.role !== 'SYSTEM');
    const withoutHidden = withoutSystem.filter((m) => !m.metadata?.hidden);
    const [filteredMessagesRaw, exploreStepMap, waitForCheckMap] =
      deduplicateToolMessages(withoutHidden);
    return { filteredMessagesRaw, exploreStepMap, waitForCheckMap };
  }, [messages, subAgentId]);
}

// ─── Streaming state filtering + derived metrics ─────────────────────────

export interface FilteredStreamingState {
  bubbles: Map<string, StreamingBubble>;
  plan: StreamingPlan | null;
  attention: StreamingAttention | null;
  tools: Map<string, StreamingTool>;
  charCount: number;
  streamStartedAtMs?: number;
  isClaude: boolean;
  isGpt: boolean;
}

interface UseFilteredStreamingOptions {
  subAgentId: string | undefined;
  streamingBubbles: Map<string, StreamingBubble>;
  streamingPlan: StreamingPlan | null;
  streamingAttention: StreamingAttention | null;
  streamingTools: Map<string, StreamingTool>;
}

export function useFilteredStreaming({
  subAgentId,
  streamingBubbles,
  streamingPlan,
  streamingAttention,
  streamingTools,
}: UseFilteredStreamingOptions): FilteredStreamingState {
  const target = subAgentId ?? null;
  return useMemo(() => {
    const bubbles = new Map(
      [...streamingBubbles].filter(([, b]) => (b.subAgentId ?? null) === target),
    );
    const tools = new Map([...streamingTools].filter(([, t]) => (t.subAgentId ?? null) === target));
    const plan =
      streamingPlan && (streamingPlan.subAgentId ?? null) === target ? streamingPlan : null;
    const attention =
      streamingAttention && (streamingAttention.subAgentId ?? null) === target
        ? streamingAttention
        : null;

    let charCount = 0;
    let streamStartedAtMs: number | undefined;
    let isClaude = false;
    let isGpt = false;
    bubbles.forEach((b) => {
      charCount += b.text.length;
      if (b.startedAtMs)
        streamStartedAtMs = Math.min(streamStartedAtMs ?? b.startedAtMs, b.startedAtMs);
      if (b.isClaude) isClaude = true;
      if (b.isGpt) isGpt = true;
    });
    tools.forEach((t) => {
      charCount += t.charCount ?? 0;
      if (t.startedAtMs)
        streamStartedAtMs = Math.min(streamStartedAtMs ?? t.startedAtMs, t.startedAtMs);
      if (t.isClaude) isClaude = true;
      if (t.isGpt) isGpt = true;
    });
    if (plan?.startedAtMs) {
      streamStartedAtMs = Math.min(streamStartedAtMs ?? plan.startedAtMs, plan.startedAtMs);
    }

    return { bubbles, plan, attention, tools, charCount, streamStartedAtMs, isClaude, isGpt };
  }, [target, streamingBubbles, streamingPlan, streamingAttention, streamingTools]);
}

// ─── Merge sub-agent tree messages by for_each/base tool call ────────────

function baseToolCallId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const colonIndex = value.indexOf(':');
  return colonIndex === -1 ? value : value.slice(0, colonIndex);
}

function isSpawnTree(m: Message): boolean {
  return (
    !!m.metadata?.toolName &&
    GENERAL_PURPOSE_AGENT_TOOLS.has(m.metadata.toolName) &&
    Array.isArray(m.metadata?.subAgentIds) &&
    (m.metadata.subAgentIds as string[]).length > 0 &&
    !!m.metadata?.busId
  );
}

function isForEachTerminal(m: Message): boolean {
  return (
    m.metadata?.toolName === 'spawn_general_purpose_agent_for_each' &&
    (m.metadata?.toolStatus === 'FINISHED' || m.metadata?.toolStatus === 'ERROR') &&
    !Array.isArray(m.metadata?.subAgentIds)
  );
}

interface SpawnGroup {
  firstIndex: number;
  ids: string[];
  firstMsg: Message;
}

interface ForEachTerminalGroup {
  messageIndex: number;
  message: Message;
  ids: string[];
  busId?: string;
}

function collectForEachTerminalGroups(messages: Message[]): Map<string, ForEachTerminalGroup> {
  const groups = new Map<string, ForEachTerminalGroup>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isForEachTerminal(msg)) continue;
    const callId = baseToolCallId(msg.metadata?.toolCallId);
    if (!callId) continue;
    groups.set(callId, { messageIndex: i, message: msg, ids: [] });
  }

  for (const msg of messages) {
    if (!isSpawnTree(msg)) continue;
    const childBaseCallId = baseToolCallId(msg.metadata?.toolCallId);
    if (!childBaseCallId) continue;
    const terminal = groups.get(childBaseCallId);
    if (!terminal) continue;
    terminal.busId = (msg.metadata?.busId as string | undefined) ?? terminal.busId;
    for (const id of msg.metadata!.subAgentIds as string[]) {
      if (!terminal.ids.includes(id)) terminal.ids.push(id);
    }
  }

  return groups;
}

function spawnGroupKey(msg: Message): string {
  return msg.metadata!.busId as string;
}

function groupSpawnTrees(messages: Message[]): {
  groupsByKey: Map<string, SpawnGroup>;
  skipIndices: Set<number>;
} {
  const terminalGroups = collectForEachTerminalGroups(messages);
  const groupsByKey = new Map<string, SpawnGroup>();
  const skipIndices = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isSpawnTree(msg)) continue;
    const childBaseCallId = baseToolCallId(msg.metadata?.toolCallId);
    const key = spawnGroupKey(msg);
    if (childBaseCallId !== null && terminalGroups.has(childBaseCallId)) {
      skipIndices.add(i);
      continue;
    }

    const group = groupsByKey.get(key);
    if (group) {
      group.ids.push(...(msg.metadata!.subAgentIds as string[]));
      skipIndices.add(i);
    } else {
      groupsByKey.set(key, {
        firstIndex: i,
        ids: [...(msg.metadata!.subAgentIds as string[])],
        firstMsg: msg,
      });
    }
  }
  return { groupsByKey, skipIndices };
}

function mergeForEachTerminalMessage(
  msg: Message,
  terminalGroups: Map<string, ForEachTerminalGroup>,
): Message {
  const callId = baseToolCallId(msg.metadata?.toolCallId);
  const terminal = callId ? terminalGroups.get(callId) : undefined;
  if (!terminal?.busId || terminal.ids.length === 0) return msg;
  return {
    ...msg,
    metadata: {
      ...msg.metadata,
      busId: terminal.busId,
      subAgentIds: terminal.ids,
      forEachAggregate: true,
    },
  };
}

function buildMergedMessages(
  messages: Message[],
  groupsByKey: Map<string, SpawnGroup>,
  skipIndices: Set<number>,
  prevCache: Map<string, Message>,
): { result: Message[]; newCache: Map<string, Message> } {
  const newCache = new Map<string, Message>();
  const result: Message[] = [];
  const terminalGroups = collectForEachTerminalGroups(messages);

  for (let i = 0; i < messages.length; i++) {
    if (skipIndices.has(i)) continue;
    let msg = messages[i];

    if (isForEachTerminal(msg)) {
      msg = mergeForEachTerminalMessage(msg, terminalGroups);
    }

    if (!isSpawnTree(msg)) {
      result.push(msg);
      continue;
    }

    const key = spawnGroupKey(msg);
    const group = groupsByKey.get(key) ?? {
      firstIndex: i,
      ids: msg.metadata!.subAgentIds as string[],
      firstMsg: msg,
    };
    const idsKey = group.ids.join(',');

    const cached = prevCache.get(key);
    if (cached && (cached.metadata?.subAgentIds as string[])?.join(',') === idsKey) {
      result.push(cached);
      newCache.set(key, cached);
    } else {
      const merged = { ...msg, metadata: { ...msg.metadata, subAgentIds: group.ids } };
      result.push(merged);
      newCache.set(key, merged);
    }
  }

  return { result, newCache };
}

export function useSubAgentTreeMerge(messages: Message[]): Message[] {
  const prevMergedRef = useRef<Map<string, Message>>(new Map());

  return useMemo(() => {
    const { result, newCache } = mergeSubAgentTreeMessages(messages, prevMergedRef.current);
    prevMergedRef.current = newCache;
    return result;
  }, [messages]);
}

export function mergeSubAgentTreeMessages(
  messages: Message[],
  prevCache: Map<string, Message> = new Map(),
): { result: Message[]; newCache: Map<string, Message> } {
  const { groupsByKey, skipIndices } = groupSpawnTrees(messages);
  return buildMergedMessages(messages, groupsByKey, skipIndices, prevCache);
}
