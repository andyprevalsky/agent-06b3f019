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
 *
 * ANSWER STREAM STATES:
 * [LIVE ONLY] -> render attention -> [MATCHING SAVED REPLY] -> render canonical only
 * [SAVED REPLY] + late matching stream -> canonical remains authoritative
 */
import { useMemo } from 'react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { userFacingMessageText } from '@/lib/userFacingMessage';
import {
  deduplicateToolMessages,
  type Message,
  type StreamingAttention,
  type StreamingBubble,
  type StreamingPlan,
  type StreamingTool,
} from '../hooks';
import type { ExploreStep, WaitForCheck } from '../types';

import { isAgentNotificationMetadata } from '@/lib/realtime-types';
import { isEnvironmentContextRow } from './environmentContext';
import { isDirectSpawnChildProgress } from './useSubAgentTreeMerge';
import { normalizeWMHCodeMessage } from './wmhCodeMessage';
import { isCodeAgentUserFacingRow } from '../hooks/codeAgentContract';

// ─── Filter messages by subAgentId ───────────────────────────────────────

/**
 * Claude Code tags progress rows with `subAgentId` (= sandbox task_id), but
 * those rows are NOT a nested agent tree. Root filtering that drops every
 * message with `subAgentId` therefore strips `claude_code_started` /
 * `task_complete` anchors when they carry a task_id, leaving only the bare
 * handler cancel (no task_id) after toolCallId dedupe — chip stuck on
 * "Spinning up...". Keep start/complete anchors on the root transcript;
 * heartbeats (`agent_observation`) stay nested.
 */
export function isClaudeCodeChipAnchor(message: Message): boolean {
  if (message.metadata?.toolName !== 'spawn_claude_code_agent') return false;
  const action = message.metadata?.action_type;
  return (
    action === 'claude_code_started' || action === 'task_complete' || action === 'session_cancelled'
  );
}

function sanitizeTrajectoryMessage(message: Message): Message {
  if (message.role === 'USER' || message.role === 'SYSTEM') return message;
  const text = userFacingMessageText(message.text);
  if (text === message.text) return message;
  return { ...message, text };
}

/**
 * Exported for blackbox coverage of the Claude Code root-visibility rule.
 * Rose Desktop also keeps a code agent's user-facing rows (send_message_to_user,
 * inline display media) in the root trajectory; flag off they stay nested.
 */
export function filterMessagesForSubAgent(
  messages: Message[],
  subAgentId: string | undefined,
  roseDesktop = false,
): Message[] {
  const target = subAgentId ?? null;
  return messages.filter((m) => {
    const msgSub = m.metadata?.subAgentId ?? null;
    if (target === null) {
      if (msgSub === null) return true;
      if (isDirectSpawnChildProgress(m)) return true;
      if (m.metadata?.agentType === 'explore') return true;
      if (isClaudeCodeChipAnchor(m)) return true;
      if (roseDesktop && isCodeAgentUserFacingRow(m)) return true;
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
  const roseDesktop = useRoseDesktop();
  return useMemo(() => {
    const filtered = filterMessagesForSubAgent(
      messages.map(normalizeWMHCodeMessage),
      subAgentId,
      roseDesktop,
    );
    const withoutSystem = filtered.filter((m) => m.role !== 'SYSTEM');
    const withoutHidden = withoutSystem
      .filter(
        (m) =>
          !m.metadata?.hidden &&
          !isEnvironmentContextRow(m) &&
          // Child completions stay in model context and feed the dock, but the
          // spawn UI already shows each child's final state: no transcript row.
          !isAgentNotificationMetadata(m.metadata),
      )
      .map(sanitizeTrajectoryMessage);
    const [filteredMessagesRaw, exploreStepMap, waitForCheckMap] =
      deduplicateToolMessages(withoutHidden);
    return { filteredMessagesRaw, exploreStepMap, waitForCheckMap };
  }, [messages, roseDesktop, subAgentId]);
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

/** Per-sub-agent streaming byte totals keyed by subAgentId (empty string = root). */
export interface SubAgentStreamingMetrics {
  charCount: number;
  streamStartedAtMs?: number;
}

function accumulateSubAgentMetrics(
  map: Map<string, SubAgentStreamingMetrics>,
  subAgentId: string | undefined,
  charDelta: number,
  startedAtMs?: number,
): void {
  const key = subAgentId ?? '';
  const existing = map.get(key) ?? { charCount: 0 };
  existing.charCount += charDelta;
  if (startedAtMs) {
    existing.streamStartedAtMs = Math.min(existing.streamStartedAtMs ?? startedAtMs, startedAtMs);
  }
  map.set(key, existing);
}

/** Build per-sub-agent char totals from raw streaming maps (before view filtering). */
export function buildStreamingMetricsBySubAgentId(
  streamingBubbles: Map<string, StreamingBubble>,
  streamingTools: Map<string, StreamingTool>,
): Map<string, SubAgentStreamingMetrics> {
  const metrics = new Map<string, SubAgentStreamingMetrics>();
  streamingBubbles.forEach((bubble) => {
    accumulateSubAgentMetrics(
      metrics,
      bubble.subAgentId,
      Math.max(bubble.charCount ?? 0, bubble.text.length),
      bubble.startedAtMs,
    );
  });
  streamingTools.forEach((tool) => {
    accumulateSubAgentMetrics(metrics, tool.subAgentId, tool.charCount ?? 0, tool.startedAtMs);
  });
  return metrics;
}

export function resolveSubAgentStreamingMetrics(
  subAgentId: string | null | undefined,
  metricsBySubAgentId: Map<string, SubAgentStreamingMetrics>,
): SubAgentStreamingMetrics {
  return metricsBySubAgentId.get(subAgentId ?? '') ?? { charCount: 0 };
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

function coalesceStreamingAttention(
  attention: StreamingAttention | null,
  persistedMessages: Message[],
  target: string | null,
): StreamingAttention | null {
  if (!attention || (attention.subAgentId ?? null) !== target) return null;
  const hasCanonicalAnswer = persistedMessages.some(
    (message) =>
      message.role === 'TOOL' &&
      message.metadata?.toolName === 'send_message_to_user' &&
      message.metadata?.toolCallId === attention.tool_call_id,
  );
  return hasCanonicalAnswer ? null : attention;
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
    const exploreTaskIds = new Set(
      persistedMessages
        .map((message) => message.metadata?.taskId)
        .filter((taskId): taskId is string => typeof taskId === 'string'),
    );
    const bubbles = new Map(
      [...streamingBubbles].filter(
        ([, b]) =>
          (b.subAgentId ?? null) === target ||
          (target === null && b.subAgentId != null && exploreTaskIds.has(b.subAgentId)),
      ),
    );
    const tools = coalesceStreamingTools(streamingTools, persistedMessages, target);
    const plan =
      streamingPlan && (streamingPlan.subAgentId ?? null) === target ? streamingPlan : null;
    const attention = coalesceStreamingAttention(streamingAttention, persistedMessages, target);

    let charCount = 0;
    let streamStartedAtMs: number | undefined;
    let isClaude = false;
    let isGpt = false;
    bubbles.forEach((b) => {
      charCount += Math.max(b.charCount ?? 0, b.text.length);
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
