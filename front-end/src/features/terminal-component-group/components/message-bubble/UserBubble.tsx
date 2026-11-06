/**
 * Right-aligned USER bubble with optional inline attachment row.
 *
 * META LINE (always, under the bubble): the local send time, with a day label
 * once it is before today (formatMessageSentAt). Delivery state sits to its left:
 *   [SENDING] "Sending ◌  3:36 PM" (metadata.clientDelivery, this browser's own sends)
 *   --agent's next step picks it up--> [DELIVERED] "3:36 PM"
 *   (lifecycle: agent-context/hooks/optimisticUserMessages.ts)
 *
 * A Browser-composer message (metadata.browserTaskId + excludeFromModel) went
 * straight to that browser, not this agent: it reads "You → Browser: …" in the
 * code-agent "You → <agent>" text style.
 */
import { formatMessageSentAt } from '@/lib/localDateTime';
import { cn } from '@/lib/utils';
import type { Message } from '../../hooks';
import { roleConfig } from './constants';
import { AttachmentDisplay } from './AttachmentDisplay';

interface UserBubbleProps {
  message: Message;
  agentId?: string;
}

export function UserBubble({ message, agentId }: UserBubbleProps) {
  const config = roleConfig.USER;
  const filePointer = message.file_pointer;
  const attachments = filePointer ? [filePointer] : [];
  const toBrowser =
    typeof message.metadata?.browserTaskId === 'string' &&
    message.metadata?.excludeFromModel === true;

  return (
    <div className="flex flex-col items-end gap-2 animate-in fade-in duration-300">
      {message.text && (
        <div
          className={cn(
            'inline-block max-w-[80%] px-4 py-2 rounded-lg border backdrop-blur-md',
            config.bg,
            config.border,
          )}
        >
          <p className="text-sm whitespace-pre-wrap break-words">
            {toBrowser && <span className="text-muted-foreground">You → Browser: </span>}
            {message.text}
          </p>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="max-w-[80%]">
          <AttachmentDisplay attachments={attachments} agentId={agentId} />
        </div>
      )}
      <MetaLine
        timestamp={message.timestamp}
        sending={message.metadata?.clientDelivery === 'sending'}
      />
    </div>
  );
}

function MetaLine({ timestamp, sending }: { timestamp: string; sending: boolean }) {
  return (
    <div
      data-testid="user-message-meta"
      className="-mt-1 flex items-center gap-2 pr-1 text-xs text-muted-foreground"
    >
      {sending && (
        <span
          data-testid="user-message-delivery"
          data-delivery-state="sending"
          className="flex items-center gap-1.5"
        >
          Sending
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
          />
        </span>
      )}
      <time dateTime={timestamp}>{formatMessageSentAt(timestamp)}</time>
    </div>
  );
}
