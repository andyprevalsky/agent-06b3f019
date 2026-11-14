/**
 * Chat USER row → UserBubble → UserMessageText (attachments/meta remain outside).
 * State: measured height <= 240px → full text, no toggle.
 *        measured height > 240px → collapsed (default) ⇄ expanded via button.
 * ResizeObserver remeasures the natural text height when content/width changes.
 * Full text stays intact for selection/copy; each message owns its toggle state.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

const PREVIEW_HEIGHT = 240; // Twelve lines at the bubble's 20px line height.

export function UserMessageText({ text, toBrowser }: { text: string; toBrowser: boolean }) {
  const id = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > PREVIEW_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, toBrowser]);

  const collapsed = !expanded;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <>
      <div
        id={id}
        style={collapsed ? { maxHeight: PREVIEW_HEIGHT, overflow: 'hidden' } : undefined}
      >
        <p
          ref={textRef}
          data-testid="user-message-text"
          className="text-sm leading-5 whitespace-pre-wrap break-words"
        >
          {toBrowser && <span className="text-muted-foreground">You → Browser: </span>}
          {text}
        </p>
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 inline-flex min-h-8 items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron className="h-3.5 w-3.5" aria-hidden />
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
