/**
 * Pure-data hooks for MessageList — filter, dedupe, stream-state memoization,
 * and sub-agent-tree merge. Split out so behavioral hooks (animation buffer,
 * thinking visibility, auto-scroll) can live in useMessageList.ts while the
 * data pipeline lives here.
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

// ─── Filter messages by subAgentId ───────────────────────────────────────

function filterMessagesForSubAgent(
  messages: Message[],
  subAgentId: string | undefined,
): Message[] {
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
    const tools = new Map(
      [...streamingTools].filter(([, t]) => (t.subAgentId ?? null) === target),
    );
    const plan =
      streamingPlan && (streamingPlan.subAgentId ?? null) === target ? streamingPlan : null;
    const attention =
      streamingAttention && (streamingAttention.subAgentId ?? null) === target
        ? streamingAttention
        : null;

    let charCount = 0;
    let isClaude = false;
    let isGpt = false;
    bubbles.forEach((b) => {
      charCount += b.text.length;
      if (b.isClaude) isClaude = true;
      if (b.isGpt) isGpt = true;
    });

    return { bubbles, plan, attention, tools, charCount, isClaude, isGpt };
  }, [target, streamingBubbles, streamingPlan, streamingAttention, streamingTools]);
}

// ─── Merge sub-agent tree messages by busId ──────────────────────────────

function isSpawnTree(m: Message): boolean {
  return (
    m.metadata?.toolName === 'spawn_sub_agent' &&
    Array.isArray(m.metadata?.subAgentIds) &&
    (m.metadata.subAgentIds as string[]).length > 0 &&
    !!m.metadata?.busId
  );
}

interface SpawnGroup {
  firstIndex: number;
  ids: string[];
  firstMsg: Message;
}

function groupSpawnTrees(messages: Message[]): {
  groupsByBus: Map<string, SpawnGroup>;
  skipIndices: Set<number>;
} {
  const groupsByBus = new Map<string, SpawnGroup>();
  const skipIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isSpawnTree(msg)) continue;
    const busId = msg.metadata!.busId as string;
    const group = groupsByBus.get(busId);
    if (group) {
      group.ids.push(...(msg.metadata!.subAgentIds as string[]));
      skipIndices.add(i);
    } else {
      groupsByBus.set(busId, {
        firstIndex: i,
        ids: [...(msg.metadata!.subAgentIds as string[])],
        firstMsg: msg,
      });
    }
  }
  return { groupsByBus, skipIndices };
}

function buildMergedMessages(
  messages: Message[],
  groupsByBus: Map<string, SpawnGroup>,
  skipIndices: Set<number>,
  prevCache: Map<string, Message>,
): { result: Message[]; newCache: Map<string, Message> } {
  const newCache = new Map<string, Message>();
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (skipIndices.has(i)) continue;
    const msg = messages[i];

    if (!isSpawnTree(msg)) {
      result.push(msg);
      continue;
    }

    const busId = msg.metadata!.busId as string;
    const group = groupsByBus.get(busId)!;
    const idsKey = group.ids.join(',');

    const cached = prevCache.get(busId);
    if (cached && (cached.metadata?.subAgentIds as string[])?.join(',') === idsKey) {
      result.push(cached);
      newCache.set(busId, cached);
    } else {
      const merged = { ...msg, metadata: { ...msg.metadata, subAgentIds: group.ids } };
      result.push(merged);
      newCache.set(busId, merged);
    }
  }

  return { result, newCache };
}

export function useSubAgentTreeMerge(messages: Message[]): Message[] {
  const prevMergedRef = useRef<Map<string, Message>>(new Map());

  return useMemo(() => {
    const { groupsByBus, skipIndices } = groupSpawnTrees(messages);
    const { result, newCache } = buildMergedMessages(
      messages,
      groupsByBus,
      skipIndices,
      prevMergedRef.current,
    );
    prevMergedRef.current = newCache;
    return result;
  }, [messages]);
}
