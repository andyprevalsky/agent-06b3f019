import { useEffect } from 'react';
import type { Message } from '../../hooks';
import type { DisplayMediaItem } from '../../hooks/codeAgentContract';
import { DisplayMediaGroup } from '../inline-media/DisplayMediaGroup';

/** One display call's media at its first row; completes the typing chain like other bubbles. */
export function DisplayMediaListItem({
  message,
  items,
  agentId,
  shouldType,
  onTypingComplete,
  onOpen,
}: {
  onOpen?: () => void;
  message: Message;
  items: DisplayMediaItem[];
  agentId?: string;
  shouldType: boolean;
  onTypingComplete: () => void;
}) {
  useEffect(() => {
    if (shouldType) onTypingComplete();
  }, [shouldType, onTypingComplete]);
  return (
    <div
      data-message-id={message.message_id}
      data-message-role={message.role}
      data-message-kind="display-media"
      className="min-w-0 max-w-full"
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="text-sm text-muted-foreground underline underline-offset-2"
        >
          Open agent display{items[0]?.caption ? ` · ${items[0].caption}` : ''}
        </button>
      ) : (
        <DisplayMediaGroup items={items} agentId={agentId} />
      )}
    </div>
  );
}
