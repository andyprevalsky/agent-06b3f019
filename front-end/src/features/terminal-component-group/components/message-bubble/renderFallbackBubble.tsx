/**
 * Fallback routes. If the specialised-bubble router returned undefined and we
 * have generic toolData, render a generic ToolMessage. Otherwise choose
 * between UserBubble, AssistantAttachmentBubble, or DefaultBubble based on
 * the message role + file_pointer presence.
 */
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';
import type { MessageBubbleProps, ToolMessageData } from './types';
import type { MessageRouting } from './useMessageRouting';
import { ToolMessage } from './ToolMessage';
import { UserBubble } from './UserBubble';
import { AssistantAttachmentBubble } from './AssistantAttachmentBubble';
import { DefaultBubble } from './DefaultBubble';

interface Args {
  props: MessageBubbleProps;
  routing: MessageRouting;
  toolData: ToolMessageData | null;
}

export function renderFallbackBubble({ props, routing, toolData }: Args): ReactElement {
  const {
    message,
    shouldType = false,
    onTypingComplete,
    isStreaming = false,
    agentId,
    compact = false,
  } = props;

  if (toolData) {
    return (
      <div className={cn('flex', !compact && 'gap-3')}>
        <div className="flex-1">
          <ToolMessage data={toolData} shouldType={shouldType} onComplete={onTypingComplete} />
        </div>
      </div>
    );
  }

  if (routing.isUser) {
    return <UserBubble message={message} agentId={agentId} />;
  }

  if (routing.isAssistant && message.file_pointer) {
    return <AssistantAttachmentBubble message={message} agentId={agentId} />;
  }

  return <DefaultBubble message={message} isStreaming={isStreaming} />;
}
