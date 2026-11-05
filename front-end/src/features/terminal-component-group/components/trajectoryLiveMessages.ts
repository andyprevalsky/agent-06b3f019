/** A streaming placeholder is replaced by its canonical tool receipt, never counted twice. */
import type { Message, StreamingTool } from '../hooks';
import { useMemo, useRef } from 'react';
import { eventTimeMs } from '../hooks/codeAgentContract';
import { trajectoryActivity } from './trajectoryWorkGroups';
/** Byte counters change independently of the tool rows projected into persisted history. */
export function useTrajectoryToolRows(
  tools: ReadonlyMap<string, StreamingTool>,
  foldedIds?: ReadonlySet<string>,
): StreamingTool[] {
  const previous = useRef<StreamingTool[]>([]);
  return useMemo(() => {
    const next: StreamingTool[] = [];
    for (const tool of tools.values()) {
      if (foldedIds?.has(tool.tool_call_id)) continue;
      next.push({
        stream_id: tool.stream_id,
        tool_call_id: tool.tool_call_id,
        tool_name: tool.tool_name,
        title: tool.title,
        startedAtMs: tool.startedAtMs,
      });
    }
    if (
      next.length === previous.current.length &&
      next.every((tool, index) => {
        const old = previous.current[index];
        return (
          tool.stream_id === old.stream_id &&
          tool.tool_call_id === old.tool_call_id &&
          tool.tool_name === old.tool_name &&
          tool.title === old.title &&
          tool.startedAtMs === old.startedAtMs
        );
      })
    )
      return previous.current;
    previous.current = next;
    return next;
  }, [tools, foldedIds]);
}
function needsThinkingPlaceholder(messages: Message[], startedAt?: number): boolean {
  if (startedAt !== undefined) {
    let latestAt = 0;
    for (const message of messages) {
      latestAt = Math.max(latestAt, eventTimeMs(message.timestamp) ?? 0);
    }
    if (startedAt > latestAt) return true;
  }
  return (
    !messages.some(trajectoryActivity) &&
    !messages.some((message) => message.metadata?.isUserAttentionMessage)
  );
}
export function withLiveTrajectory(
  messages: Message[],
  tools: StreamingTool[],
  thinking: boolean,
  startedAt?: number,
  status?: string,
): Message[] {
  if (status && ['COMPLETED', 'FAILED', 'PAUSED', 'CANCELLED'].includes(status)) return messages;
  if (!tools.length && !thinking) return messages;
  const calls = new Set(
    tools.length ? messages.map((message) => message.metadata?.toolCallId) : [],
  );
  const live = tools
    .filter((tool) => !calls.has(tool.tool_call_id))
    .map((tool): Message => ({
      message_id: `streaming:${tool.tool_call_id}`,
      role: 'TOOL',
      text: '',
      timestamp: tool.startedAtMs ? new Date(tool.startedAtMs).toISOString() : '',
      metadata: {
        toolCallId: tool.tool_call_id,
        toolName: tool.tool_name,
        title: tool.title,
        toolStatus: 'IN_PROGRESS',
        ephemeral: true,
      },
    }));
  if (thinking && !tools.length && needsThinkingPlaceholder(messages, startedAt))
    live.push({
      message_id: 'streaming:thinking',
      role: 'TOOL',
      text: '',
      timestamp: startedAt ? new Date(startedAt).toISOString() : '',
      metadata: {
        toolName: 'thought',
        title: 'Thinking',
        toolStatus: 'IN_PROGRESS',
        ephemeral: true,
      },
    });
  return live.length ? [...messages, ...live] : messages;
}
