/**
 * Pure-data hooks for MessageList — filter, dedupe, stream-state memoization,
 * and sub-agent-tree merge. Split out so behavioral hooks (animation buffer,
 * thinking visibility, auto-scroll) can live in useMessageList.ts while the
 * data pipeline lives here.
 *
 * SUB-AGENT MERGE STATES:
 * [RAW SPAWN ROWS] -> group by spawnGroupId (busId for legacy rows) -> [ONE TREE PER TURN/TASK]
 * [LEGACY CHILD ROW] -> synthesize busId/subAgentIds from root id + subAgentId -> [LIVE TREE]
 * [FOR_EACH TERMINAL] -> use emitted child ids or infer legacy rows -> [AGGREGATE TREE]
 * [NO TERMINAL YET] -> keep live child tree rows visible
 */
import { useMemo } from 'react';
import {
  deduplicateToolMessages,
  type Message,
  type StreamingAttention,
  type StreamingBubble,
  type StreamingPlan,
  type StreamingTool,
} from '../hooks';
import type { ExploreStep, WaitForCheck } from '../types';

import { isDirectSpawnChildProgress } from './useSubAgentTreeMerge';

// ─── Filter messages by subAgentId ───────────────────────────────────────

function filterMessagesForSubAgent(messages: Message[], subAgentId: string | undefined): Message[] {
  const target = subAgentId ?? null;
  return messages.filter((m) => {
    const msgSub = m.metadata?.subAgentId ?? null;
    if (target === null) {
      if (msgSub === null) return true;
      if (isDirectSpawnChildProgress(m)) return true;
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
  persistedMessages: Message[];
  streamingBubbles: Map<string, StreamingBubble>;
  streamingPlan: StreamingPlan | null;
  streamingAttention: StreamingAttention | null;
  streamingTools: Map<string, StreamingTool>;
}

export function coalesceStreamingTools(
  streamingTools: Map<string, StreamingTool>,
  persistedMessages: Message[],
  target: string | null,
): Map<string, StreamingTool> {
  const persistedToolCallIds = new Set(
    persistedMessages
      .map((message) => message.metadata?.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  return new Map(
    [...streamingTools].filter(
      ([toolCallId, tool]) =>
        (tool.subAgentId ?? null) === target && !persistedToolCallIds.has(toolCallId),
    ),
  );
}

export function useFilteredStreaming({
  subAgentId,
  persistedMessages,
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
    const tools = coalesceStreamingTools(streamingTools, persistedMessages, target);
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
  }, [
    target,
    persistedMessages,
    streamingBubbles,
    streamingPlan,
    streamingAttention,
    streamingTools,
  ]);
}

export { mergeSubAgentTreeMessages, useSubAgentTreeMerge } from './useSubAgentTreeMerge';
