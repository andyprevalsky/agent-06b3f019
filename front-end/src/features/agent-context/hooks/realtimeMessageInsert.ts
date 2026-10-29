import type { InsertMessagePayload } from '@/lib/realtime';
import type { Message } from '@/lib/api';
import type { RealtimeSetters } from './realtimeHandlers';

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
    const streamId =
      typeof message.metadata?.streamId === 'string' ? message.metadata.streamId : null;
    const persistedAtMs = Date.parse(message.timestamp);
    setters.setStreamingBubbles((prev) => {
      const newMap = new Map(prev);
      if (streamId) {
        const bubble = newMap.get(streamId);
        if (bubble?.timeoutId) window.clearTimeout(bubble.timeoutId);
        newMap.delete(streamId);
        return newMap;
      }
      for (const [streamId, bubble] of newMap) {
        // A legacy message has no stream identity. Its delayed first delivery
        // must not settle a later request's bubble; prefer the producer clock.
        const startedAtMs = bubble.llmStartedAtMs ?? bubble.startedAtMs;
        const newerStream = startedAtMs !== undefined && startedAtMs > persistedAtMs;
        if (!newerStream && (bubble.subAgentId ?? null) === subAgentId) {
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
    setters.setStreamingPlan((prev) =>
      prev?.tool_call_id === message.metadata?.toolCallId ? null : prev,
    );
  }

  if (
    message.role === 'TOOL' &&
    message.metadata?.toolName === 'send_message_to_user' &&
    typeof message.metadata?.toolCallId === 'string'
  ) {
    setters.setStreamingAttention((prev) =>
      prev?.tool_call_id === message.metadata?.toolCallId ? null : prev,
    );
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
    const index = prev.findIndex((m) => m.message_id === message.message_id);
    if (index < 0) return [...prev, message];
    const existing = prev[index];
    const pause = message.metadata?.userPause;
    if (
      pause?.reason !== 'user' ||
      pause.recordedAt <= (existing.metadata?.userPause?.recordedAt ?? '') ||
      message.timestamp !== existing.timestamp ||
      message.metadata?.toolCallId !== existing.metadata?.toolCallId ||
      message.metadata?.workflowGeneration !== existing.metadata?.workflowGeneration
    )
      return prev;
    return prev.map((row, i) => (i === index ? message : row));
  });
  setters.dispatchMessage(message);
}
