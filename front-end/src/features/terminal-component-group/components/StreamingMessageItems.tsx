/**
 * STATE MACHINE: StreamingMessageItems
 *
 * Renders in-flight streaming tool calls and streaming user-attention messages
 * as placeholder MessageBubbles. These are ephemeral — each corresponds to a
 * streaming event that will eventually be persisted as a real Message.
 */
import MessageBubble from './MessageBubble';
import type { StreamingTool, StreamingAttention } from '../hooks';

interface StreamingToolsProps {
  tools: StreamingTool[];
  compact?: boolean;
}

export function StreamingTools({ tools, compact }: StreamingToolsProps) {
  return (
    <>
      {tools.map((tool) => (
        <MessageBubble
          key={`streaming-tool-${tool.tool_call_id}`}
          message={{
            message_id: `streaming-${tool.tool_call_id}`,
            role: 'TOOL',
            text: '',
            timestamp: new Date().toISOString(),
            metadata: {
              toolCallId: tool.tool_call_id,
              toolName: tool.tool_name,
              toolStatus: 'IN_PROGRESS',
              title: tool.title,
            },
          }}
          shouldType={false}
          onTypingComplete={() => {}}
          compact={compact}
        />
      ))}
    </>
  );
}

interface StreamingAttentionBubbleProps {
  attention: StreamingAttention;
  onSendMessage: (text: string) => void | Promise<void>;
}

export function StreamingAttentionBubble({
  attention,
  onSendMessage,
}: StreamingAttentionBubbleProps) {
  return (
    <div
      className="flex gap-3 mt-4"
      data-stream-kind="final-answer"
      data-stream-state={attention.done ? 'terminal' : 'streaming'}
      data-stream-id={attention.stream_id}
      data-tool-call-id={attention.tool_call_id}
    >
      <MessageBubble
        key={`streaming-attention-${attention.tool_call_id}`}
        message={{
          message_id: `streaming-${attention.tool_call_id}`,
          role: 'TOOL',
          text: attention.message,
          timestamp: new Date().toISOString(),
          metadata: {
            toolCallId: attention.tool_call_id,
            toolName: 'send_message_to_user',
            toolStatus: attention.done ? 'FINISHED' : 'IN_PROGRESS',
            isUserAttentionMessage: true,
            attentionMessage: attention.message,
          },
        }}
        shouldType={false}
        onTypingComplete={() => {}}
        onSendMessage={onSendMessage}
        isStreaming={true}
      />
    </div>
  );
}
