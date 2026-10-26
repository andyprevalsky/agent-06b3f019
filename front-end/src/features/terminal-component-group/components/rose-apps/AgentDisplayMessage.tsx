/**
 * STATE MACHINE: DisplayMediaListItem (one display call's media at its first row)
 *   always            → DisplayMediaGroup inline in the chat (caption, gallery / frame)
 *   onOpen (the active app conversation routes displays to the Agent Display panel)
 *                     → plus an "Open agent display" text button: opens this output
 *                       full size in the panel (the panel keeps its own single frame)
 *   shouldType        → completes the typing chain like other bubbles
 *
 * Reads only what DisplayMediaGroup already reads (signed URLs once per file set);
 * the button reads nothing.
 */
import { useEffect } from 'react';
import type { Message } from '../../hooks';
import type { DisplayMediaItem } from '../../hooks/codeAgentContract';
import { DisplayMediaGroup } from '../inline-media/DisplayMediaGroup';

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
      <DisplayMediaGroup items={items} agentId={agentId} />
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="mt-1 text-sm text-muted-foreground underline underline-offset-2"
        >
          Open agent display
        </button>
      )}
    </div>
  );
}
