import { type RealtimeChannel } from '@supabase/supabase-js';
import {
  unsubscribe,
  type AssistantStreamPayload,
  type PlanStreamPayload,
  type AttentionStreamPayload,
  type ToolStreamPayload,
  type InsertMessagePayload,
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

export function handleInsertMessage(
  data: InsertMessagePayload,
  selectedAgentId: string,
  setters: Pick<
    RealtimeSetters,
    | 'setStreamingBubbles'
    | 'setStreamingPlan'
    | 'setStreamingAttention'
    | 'setStreamingTools'
    | 'setMessages'
    | 'dispatchMessage'
  >,
) {
  if (data.agentId !== selectedAgentId) return;

  const message: Message = {
    message_id: data.id,
    timestamp: data.timestamp,
    text: data.text,
    role: data.role,
    metadata: data.metadata ?? undefined,
    file_pointer: data.file_pointer ?? undefined,
  };

  if (message.role === 'ASSISTANT') {
    const subAgentId = message.metadata?.subAgentId ?? null;
    setters.setStreamingBubbles((prev) => {
      const newMap = new Map(prev);
      for (const [streamId, bubble] of newMap) {
        if ((bubble.subAgentId ?? null) === subAgentId) {
          if (bubble.timeoutId) window.clearTimeout(bubble.timeoutId);
          newMap.delete(streamId);
        }
      }
      return newMap;
    });
  }

  if (
    message.role === 'TOOL' &&
    message.metadata?.toolName === 'set_plan' &&
    message.metadata?.toolStatus === 'FINISHED'
  ) {
    setters.setStreamingPlan(null);
  }

  if (message.role === 'TOOL' && message.metadata?.toolName === 'send_message_to_user') {
    setters.setStreamingAttention(null);
  }

  if (message.role === 'TOOL' && message.metadata?.toolCallId) {
    setters.setStreamingTools((prev) => {
      if (prev.has(message.metadata!.toolCallId)) {
        const newMap = new Map(prev);
        newMap.delete(message.metadata!.toolCallId);
        return newMap;
      }
      return prev;
    });
  }

  setters.setMessages((prev) => {
    if (prev.some((m) => m.message_id === message.message_id)) return prev;
    return [...prev, message];
  });
  setters.dispatchMessage(message);
}

export function handleUpdateAgent(
  updated: UpdateAgentPayload,
  setAgent: RealtimeSetters['setAgent'],
  setIsChatMode: RealtimeSetters['setIsChatMode'],
  onLoadAgents?: () => void,
) {
  setAgent((prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      progress: updated.progress ?? prev.progress,
      status: updated.status ?? prev.status,
      status_message: updated.statusMessage ?? prev.status_message,
      model: updated.model ?? prev.model,
      token_count: updated.tokenCount ?? prev.token_count,
      tokens_in: updated.tokensIn ?? prev.tokens_in,
      tokens_out: updated.tokensOut ?? prev.tokens_out,
      context_size: updated.contextSize ?? prev.context_size,
      message_count: updated.messageCount ?? prev.message_count,
      tree_cost_cents: updated.treeCostCents ?? prev.tree_cost_cents,
      updated_at: updated.updatedAt ?? prev.updated_at,
      temporal_workflow_id:
        updated.temporalWorkflowId !== undefined
          ? updated.temporalWorkflowId
          : prev.temporal_workflow_id,
    };
  });

  if (updated.temporalWorkflowId !== undefined) {
    setIsChatMode(!updated.temporalWorkflowId);
  }

  onLoadAgents?.();
}

export function handleAssistantStream(
  chunk: AssistantStreamPayload,
  selectedAgentId: string,
  streamedTextsRef: React.MutableRefObject<Set<string>>,
  setStreamingBubbles: RealtimeSetters['setStreamingBubbles'],
) {
  if (chunk.agentId !== selectedAgentId) return;

  setStreamingBubbles((prev) => {
    const newMap = new Map(prev);
    const existing = newMap.get(chunk.stream_id);

    if (!existing || chunk.sequence >= existing.sequence) {
      if (existing?.timeoutId) window.clearTimeout(existing.timeoutId);

      const accumulatedText = (existing?.text || '') + chunk.delta;

      let timeoutId: number | undefined;
      if (chunk.done) {
        if (accumulatedText.trim()) {
          streamedTextsRef.current.add(accumulatedText.trim());
        }

        timeoutId = window.setTimeout(() => {
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
        isClaude: chunk.is_claude ?? existing?.isClaude ?? false,
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

  setStreamingPlan({
    stream_id: plan.stream_id,
    tool_call_id: plan.tool_call_id,
    title: plan.title,
    char_count: plan.char_count ?? 0,
  });
}

export function handleAttentionStream(
  attention: AttentionStreamPayload,
  selectedAgentId: string,
  setStreamingAttention: RealtimeSetters['setStreamingAttention'],
) {
  if (attention.agentId !== selectedAgentId) return;

  setStreamingAttention({
    stream_id: attention.stream_id,
    tool_call_id: attention.tool_call_id,
    message: attention.message,
    is_question: false,
  });
}

export function handleToolStream(
  tool: ToolStreamPayload,
  selectedAgentId: string,
  setStreamingTools: RealtimeSetters['setStreamingTools'],
) {
  if (tool.agentId !== selectedAgentId) return;

  setStreamingTools((prev) => {
    const newMap = new Map(prev);
    newMap.set(tool.tool_call_id, {
      stream_id: tool.stream_id,
      tool_call_id: tool.tool_call_id,
      tool_name: tool.tool_name,
      title: tool.title,
    });
    return newMap;
  });
}

// ─── Cleanup helper ─────────────────────────────────────────────────────────

export function cleanupSubscription(
  isReconnectingRef: React.MutableRefObject<boolean>,
  reconnectTimeoutRef: React.MutableRefObject<number | null>,
  channelRef: React.MutableRefObject<RealtimeChannel | null>,
  setStreamingBubbles: RealtimeSetters['setStreamingBubbles'],
  setStreamingPlan: RealtimeSetters['setStreamingPlan'],
  setStreamingAttention: RealtimeSetters['setStreamingAttention'],
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

  setStreamingBubbles((prev) => {
    for (const [, bubble] of prev) {
      if (bubble.timeoutId) window.clearTimeout(bubble.timeoutId);
    }
    return new Map();
  });

  setStreamingPlan(null);
  setStreamingAttention(null);
}
