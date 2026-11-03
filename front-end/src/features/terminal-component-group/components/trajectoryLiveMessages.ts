/** A streaming placeholder is replaced by its canonical tool receipt, never counted twice. */
import type { Message, StreamingTool } from '../hooks';
import { eventTimeMs } from '../hooks/codeAgentContract';
import { trajectoryActivity } from './trajectoryWorkGroups';
export function withLiveTrajectory(
  messages: Message[],
  tools: StreamingTool[],
  thinking: boolean,
  startedAt?: number,
  status?: string,
): Message[] {
  if (status && ['COMPLETED', 'FAILED', 'PAUSED', 'CANCELLED'].includes(status)) return messages;
  const calls = new Set(messages.map((message) => message.metadata?.toolCallId));
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
  const latestAt = Math.max(0, ...messages.map((message) => eventTimeMs(message.timestamp) ?? 0));
  if (
    thinking &&
    !tools.length &&
    ((!messages.some(trajectoryActivity) &&
      !messages.some((message) => message.metadata?.isUserAttentionMessage)) ||
      (startedAt !== undefined && startedAt > latestAt))
  )
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
