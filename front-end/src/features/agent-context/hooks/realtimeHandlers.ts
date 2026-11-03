import {
  isTerminalStatus,
  isProgressEstimateUpdate,
  applyProgressEstimateUpdate,
  mergeProgressEstimate,
  mergeTaskProgressEstimates,
} from '@/lib/progressEstimate';
import { type RealtimeChannel } from '@supabase/supabase-js';
import {
  unsubscribe,
  type AssistantStreamPayload,
  type PlanStreamPayload,
  type AttentionStreamPayload,
  type ToolStreamPayload,
  type UpdateAgentPayload,
} from '@/lib/realtime';
import type { AgentDetail, Message } from '@/lib/api';

import type { StreamingBubble, StreamingPlan, StreamingAttention, StreamingTool } from '../types';
import { STREAM_TIMEOUT_MS } from '../config';

// ─── Shared setter types ────────────────────────────────────────────────────

export interface RealtimeSetters {
  setStreamingBubbles: React.Dispatch<React.SetStateAction<Map<string, StreamingBubble>>>;
  setStreamingPlan: React.Dispatch<React.SetStateAction<StreamingPlan | null>>;
  setStreamingAttention: React.Dispatch<React.SetStateAction<StreamingAttention | null>>;
  setStreamingTools: React.Dispatch<React.SetStateAction<Map<string, StreamingTool>>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>;
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>;
  dispatchMessage: (message: Message) => void;
}

// ─── Realtime event handlers (pure functions, no hooks) ─────────────────────

export { handleInsertMessage } from './realtimeMessageInsert';

const TERMINAL_CHAT_RESTORE_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
]);

export function shouldRestoreChatMode(updated: UpdateAgentPayload): boolean {
  if (updated.status !== undefined && TERMINAL_CHAT_RESTORE_STATUSES.has(updated.status)) {
    return true;
  }
  return updated.temporalWorkflowId !== undefined && !updated.temporalWorkflowId;
}

export function isChatCapableAgent(agent: {
  status?: string;
  temporal_workflow_id?: string | null;
}): boolean {
  if (agent.status !== undefined && TERMINAL_CHAT_RESTORE_STATUSES.has(agent.status)) {
    return true;
  }
  return !agent.temporal_workflow_id;
}

export function handleUpdateAgent(
  updated: UpdateAgentPayload,
  setAgent: RealtimeSetters['setAgent'],
  setIsChatMode: RealtimeSetters['setIsChatMode'],
  onLoadAgents?: () => void,
) {
  const predictionOnly = isProgressEstimateUpdate(updated);
  setAgent((prev) => {
    if (!prev || (updated.agentId && updated.agentId !== prev.agent_id)) return prev;
    if (predictionOnly) return applyProgressEstimateUpdate(prev, updated);
    if (updated.updatedAt && Date.parse(updated.updatedAt) < Date.parse(prev.updated_at))
      return prev;
    if (
      isTerminalStatus(prev.status) &&
      updated.progressEstimate &&
      (!updated.updatedAt || Date.parse(updated.updatedAt) <= Date.parse(prev.updated_at))
    )
      return prev;
    const generationChanged =
      updated.temporalWorkflowId !== undefined &&
      updated.temporalWorkflowId !== prev.temporal_workflow_id;
    return {
      ...prev,
      title: updated.title !== undefined ? updated.title : prev.title,
      progress: updated.progress ?? prev.progress,
      task_progress_estimates: mergeTaskProgressEstimates(
        generationChanged ? undefined : prev.task_progress_estimates,
        updated.taskProgressEstimates,
      ),
      progress_estimate: mergeProgressEstimate(
        generationChanged ? undefined : prev.progress_estimate,
        updated.progressEstimate,
        prev.agent_id,
        updated.status ?? prev.status,
        updated.taskId ?? prev.task_id,
      ),
      status: updated.status ?? prev.status,
      status_message: updated.statusMessage ?? prev.status_message,
      model: updated.model ?? prev.model,
      token_count: updated.tokenCount ?? prev.token_count,
      tokens_in: updated.tokensIn ?? prev.tokens_in,
      tokens_out: updated.tokensOut ?? prev.tokens_out,
      context_size: updated.contextSize ?? prev.context_size,
      message_count: updated.messageCount ?? prev.message_count,
      // Tree cost is monotonic within a run, but the workflow fans out cost
      // updates from several concurrent, retryable broadcast activities with no
      // ordering guarantee — so a stale (smaller) payload can arrive after a
      // newer (larger) one. Clamp to the max seen to stop the value flickering
      // down. (Backend single-emitter coalescing is the primary fix; this is
      // the belt-and-suspenders guard at the sink.)
      tree_cost_cents:
        updated.treeCostCents !== undefined && updated.treeCostCents !== null
          ? Math.max(prev.tree_cost_cents ?? 0, updated.treeCostCents)
          : prev.tree_cost_cents,
      updated_at: updated.updatedAt ?? prev.updated_at,
      temporal_workflow_id:
        updated.temporalWorkflowId !== undefined
          ? updated.temporalWorkflowId
          : prev.temporal_workflow_id,
    };
  });

  if (predictionOnly) return;

  if (shouldRestoreChatMode(updated)) {
    setIsChatMode(true);
  } else if (updated.temporalWorkflowId !== undefined) {
    setIsChatMode(!updated.temporalWorkflowId);
  }

  onLoadAgents?.();
}

export function handleAssistantStream(
  chunk: AssistantStreamPayload,
  selectedAgentId: string,
  streamedTextsRef: React.MutableRefObject<Set<string>>,
  setStreamingBubbles: RealtimeSetters['setStreamingBubbles'],
  completedStreamIdsRef?: React.MutableRefObject<Set<string>>,
  isCurrentAgent: () => boolean = () => true,
) {
  if (chunk.agentId !== selectedAgentId) return;

  setStreamingBubbles((prev) => {
    if (completedStreamIdsRef?.current.has(chunk.stream_id)) return prev;
    const existing = prev.get(chunk.stream_id);
    if (existing && chunk.sequence < existing.sequence) return prev;
    const newMap = new Map(prev);

    if (!existing || chunk.sequence >= existing.sequence) {
      if (existing?.timeoutId) window.clearTimeout(existing.timeoutId);

      const accumulatedText = (existing?.text || '') + chunk.delta;
      const reportedCharCount = chunk.char_count ?? 0;
      const charCount = Math.max(
        reportedCharCount,
        accumulatedText.length,
        existing?.charCount ?? 0,
      );

      if (chunk.done && chunk.clear_on_done) {
        if (accumulatedText.trim()) {
          streamedTextsRef.current.add(accumulatedText.trim());
        }
        completedStreamIdsRef?.current.add(chunk.stream_id);
        newMap.delete(chunk.stream_id);
        return newMap;
      }

      let timeoutId: number | undefined;
      if (chunk.done) {
        if (accumulatedText.trim()) {
          streamedTextsRef.current.add(accumulatedText.trim());
        }

        timeoutId = window.setTimeout(() => {
          if (!isCurrentAgent()) return;
          console.warn(`Stream ${chunk.stream_id} timeout`);
          setStreamingBubbles((p) => {
            const m = new Map(p);
            m.delete(chunk.stream_id);
            return m;
          });
        }, STREAM_TIMEOUT_MS);
      }

      newMap.set(chunk.stream_id, {
        text: accumulatedText,
        sequence: chunk.sequence,
        done: chunk.done,
        timeoutId,
        subAgentId: chunk.subAgentId ?? existing?.subAgentId,
        startedAtMs: chunk.llm_started_at_ms ?? existing?.startedAtMs ?? Date.now(),
        llmStartedAtMs: chunk.llm_started_at_ms ?? existing?.llmStartedAtMs,
        isClaude: chunk.is_claude ?? existing?.isClaude ?? false,
        isGpt: chunk.is_gpt ?? existing?.isGpt ?? false,
        charCount,
      });
    }

    return newMap;
  });
}

export function handlePlanStream(
  plan: PlanStreamPayload,
  selectedAgentId: string,
  setStreamingPlan: RealtimeSetters['setStreamingPlan'],
) {
  if (plan.agentId !== selectedAgentId) return;

  setStreamingPlan((prev) => {
    const isSamePlan = prev?.tool_call_id === plan.tool_call_id;
    return {
      stream_id: plan.stream_id,
      tool_call_id: plan.tool_call_id,
      title: plan.title,
      char_count: plan.char_count ?? 0,
      startedAtMs:
        plan.llm_started_at_ms ?? (isSamePlan ? prev?.startedAtMs : undefined) ?? Date.now(),
    };
  });
}

export function handleAttentionStream(
  attention: AttentionStreamPayload,
  selectedAgentId: string,
  setStreamingAttention: RealtimeSetters['setStreamingAttention'],
) {
  if (attention.agentId !== selectedAgentId) return;

  setStreamingAttention((prev) => {
    const isMatchingStream = prev?.tool_call_id === attention.tool_call_id;
    if (isMatchingStream && attention.sequence <= prev.sequence) return prev;
    if (attention.done && attention.message.length === 0) {
      return isMatchingStream || prev === null ? null : prev;
    }
    if (attention.message.length === 0) return prev;
    return {
      stream_id: attention.stream_id,
      tool_call_id: attention.tool_call_id,
      message: attention.message,
      is_question: false,
      sequence: attention.sequence,
      done: attention.done,
    };
  });
}

export function handleToolStream(
  tool: ToolStreamPayload,
  selectedAgentId: string,
  setStreamingTools: RealtimeSetters['setStreamingTools'],
) {
  if (tool.agentId !== selectedAgentId) return;

  setStreamingTools((prev) => {
    const terminal = tool.status === 'FINISHED' || tool.status === 'ERROR';
    if (terminal && !prev.has(tool.tool_call_id)) return prev;
    const newMap = new Map(prev);
    if (terminal) {
      newMap.delete(tool.tool_call_id);
      return newMap;
    }

    newMap.set(tool.tool_call_id, {
      stream_id: tool.stream_id,
      tool_call_id: tool.tool_call_id,
      tool_name: tool.tool_name,
      title: tool.title,
      subAgentId: tool.subAgentId ?? prev.get(tool.tool_call_id)?.subAgentId,
      charCount: tool.char_count ?? prev.get(tool.tool_call_id)?.charCount ?? 0,
      startedAtMs: tool.llm_started_at_ms ?? prev.get(tool.tool_call_id)?.startedAtMs ?? Date.now(),
      isClaude: tool.is_claude ?? prev.get(tool.tool_call_id)?.isClaude ?? false,
      isGpt: tool.is_gpt ?? prev.get(tool.tool_call_id)?.isGpt ?? false,
    });
    return newMap;
  });
}

// ─── Cleanup helper ─────────────────────────────────────────────────────────

/** Clearing streaming state also releases every expiry timer owned by its bubbles. */
export function resetStreamingBubbles(setStreamingBubbles: RealtimeSetters['setStreamingBubbles']) {
  setStreamingBubbles((previous) => {
    for (const bubble of previous.values()) {
      if (bubble.timeoutId) globalThis.clearTimeout(bubble.timeoutId);
    }
    return previous.size === 0 ? previous : new Map();
  });
}

export function cleanupSubscription(
  isReconnectingRef: React.MutableRefObject<boolean>,
  reconnectTimeoutRef: React.MutableRefObject<number | null>,
  channelRef: React.MutableRefObject<RealtimeChannel | null>,
  setStreamingBubbles: RealtimeSetters['setStreamingBubbles'],
  setStreamingPlan: RealtimeSetters['setStreamingPlan'],
  setStreamingAttention: RealtimeSetters['setStreamingAttention'],
  setStreamingTools: RealtimeSetters['setStreamingTools'],
) {
  isReconnectingRef.current = false;

  if (reconnectTimeoutRef.current) {
    clearTimeout(reconnectTimeoutRef.current);
    reconnectTimeoutRef.current = null;
  }

  if (channelRef.current) {
    unsubscribe(channelRef.current);
    channelRef.current = null;
  }

  resetStreamingBubbles(setStreamingBubbles);

  setStreamingPlan(null);
  setStreamingTools(() => new Map());
  setStreamingAttention(null);
}
