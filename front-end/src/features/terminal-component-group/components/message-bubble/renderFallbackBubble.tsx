/**
 * Fallback routes. Inbound agent messages render as InboundAgentRow; child
 * completions render nothing. If the specialised-bubble router returned undefined and we
 * have generic toolData, render a generic ToolMessage. Empty synthetic thought
 * messages render nothing. Otherwise choose between UserBubble,
 * AssistantAttachmentBubble, or DefaultBubble based on the message role +
 * file_pointer presence.
 */
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';
import type { MessageBubbleProps, ToolMessageData } from './types';
import type { MessageRouting } from './useMessageRouting';
import { ToolMessage } from './ToolMessage';
import { UserBubble } from './UserBubble';
import { AssistantAttachmentBubble } from './AssistantAttachmentBubble';
import { DefaultBubble } from './DefaultBubble';
import { InboundAgentRow } from '../agent-rows/InboundAgentRow';

interface Args {
  props: MessageBubbleProps;
  routing: MessageRouting;
  toolData: ToolMessageData | null;
}

export function renderFallbackBubble({ props, routing, toolData }: Args): ReactElement | null {
  const {
    message,
    shouldType = false,
    onTypingComplete,
    isStreaming = false,
    agentId,
    compact = false,
  } = props;

  // Inbound agent messages (USER or ASSISTANT role) get the inbound style,
  // never a user bubble or tool chip. Child completions never render (the
  // trajectory filter drops them; null keeps a stray one out of the chat).
  if (routing.isAgentNotification) return null;
  if (routing.isAgentMessage) return <InboundAgentRow message={message} />;

  if (toolData) {
    return (
      <div className={cn('flex min-w-0 max-w-full', !compact && 'gap-3')}>
        <div className="min-w-0 max-w-full flex-1">
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

  if (routing.isAssistant && !isStreaming && message.text.trim().length === 0) {
    return null;
  }

  return <DefaultBubble message={message} isStreaming={isStreaming} />;
}
