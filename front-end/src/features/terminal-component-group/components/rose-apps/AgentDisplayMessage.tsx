/**
 * STATE MACHINE: DisplayMediaListItem (one display call's media at its first row)
 *   Every display renders inline in the chat; there is no separate Agent Display
 *   panel or app icon. A chevron row (caption, else filename) discloses size:
 *
 *   [EXPANDED] (default) the display at full size: a page frame is as tall as
 *        the page reports (very tall cap, see DisplayMediaGroup), so the chat
 *        scrolls and the frame never scrolls inside it; images/media at natural
 *        size --click chevron row--> [COLLAPSED]
 *   [COLLAPSED] the same frame as a short preview (clipped at PREVIEW_HEIGHT;
 *        one live frame) --click chevron row--> [EXPANDED]
 *   Toggling never remounts the frame (same element, only its box changes).
 *
 *   shouldType → completes the typing chain like other bubbles
 *
 * Reads only what DisplayMediaGroup already reads (signed URLs once per file set).
 */
import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message } from '../../hooks';
import type { DisplayMediaItem } from '../../hooks/codeAgentContract';
import { DisplayMediaGroup } from '../inline-media/DisplayMediaGroup';

const PREVIEW_HEIGHT = 'max-h-[240px]';

function displayLabel(items: DisplayMediaItem[]): string {
  const [lead] = items;
  const caption = lead?.caption?.trim();
  if (caption) return caption;
  return lead?.file.original_filename || 'Display';
}

export function DisplayMediaListItem({
  message,
  items,
  agentId,
  shouldType,
  onTypingComplete,
}: {
  message: Message;
  items: DisplayMediaItem[];
  agentId?: string;
  shouldType: boolean;
  onTypingComplete: () => void;
}) {
  useEffect(() => {
    if (shouldType) onTypingComplete();
  }, [shouldType, onTypingComplete]);
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  const label = displayLabel(items);
  return (
    <div
      data-message-id={message.message_id}
      data-message-role={message.role}
      data-message-kind="display-media"
      data-expanded={expanded}
      className="min-w-0 max-w-full"
    >
      <button
        type="button"
        data-testid="display-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={expanded ? `Collapse display: ${label}` : `Expand display: ${label}`}
        onClick={() => setExpanded((open) => !open)}
        className="flex min-h-8 w-full min-w-0 items-center gap-2 py-1 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown size={14} aria-hidden className="shrink-0" />
        ) : (
          <ChevronRight size={14} aria-hidden className="shrink-0" />
        )}
        <span
          className={cn(
            'min-w-0 flex-1',
            expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
          )}
        >
          {label}
        </span>
      </button>
      <div
        id={bodyId}
        data-testid="display-body"
        className={cn('flex min-w-0 flex-col', !expanded && cn(PREVIEW_HEIGHT, 'overflow-hidden'))}
      >
        <DisplayMediaGroup items={items} agentId={agentId} fullHeight={expanded} hideCaption />
      </div>
    </div>
  );
}
