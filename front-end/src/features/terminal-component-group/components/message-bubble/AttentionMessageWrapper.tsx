/**
 * Wraps AttentionMessage to wire up the auto-execution prompt when an
 * onSendMessage callback is available.
 */
import type { Message } from '../../hooks';
import { rejectAttentionRequest, respondToAttentionRequest } from '../../hooks';
import { AttentionMessage } from './AttentionMessage';

const AUTONOMOUS_EXECUTION_PROMPT =
  'Please do not ask me anymore questions. I trust your judgment, intuition, and ability to make reasonable assumptions. Please proceed to the Autonomous Execution phase.';

interface AttentionMessageWrapperProps {
  message: Message;
  shouldType?: boolean;
  isStreaming?: boolean;
  onTypingComplete?: () => void;
  onSendMessage?: (message: string) => void | Promise<void>;
}

export function AttentionMessageWrapper({
  message,
  shouldType,
  isStreaming,
  onTypingComplete,
  onSendMessage,
}: AttentionMessageWrapperProps) {
  const attentionMessage =
    (message.metadata?.attentionMessage as string | undefined) || message.text;
  const isWaiting = message.metadata?.toolStatus === 'IN_PROGRESS';
  const approvalMetadata = message.metadata?.requestUserApproval as
    { attentionRequestId?: unknown } | undefined;
  const attentionRequestId =
    typeof approvalMetadata?.attentionRequestId === 'string'
      ? approvalMetadata.attentionRequestId
      : undefined;

  const handleStartExecution = onSendMessage
    ? () => onSendMessage(AUTONOMOUS_EXECUTION_PROMPT)
    : undefined;

  return (
    <AttentionMessage
      attentionMessage={attentionMessage}
      isWaiting={isWaiting}
      shouldType={shouldType}
      onComplete={onTypingComplete}
      onStartExecution={handleStartExecution}
      isStreaming={isStreaming}
      attentionRequestId={attentionRequestId}
      onApprove={(requestId) => respondToAttentionRequest(requestId, 'Approved')}
      onDecline={(requestId) => rejectAttentionRequest(requestId)}
      sentAt={isStreaming ? undefined : message.timestamp}
    />
  );
}
