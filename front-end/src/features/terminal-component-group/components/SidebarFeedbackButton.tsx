/**
 * STATE MACHINE: SidebarFeedbackButton
 *
 * [COLLAPSED] <-- expanded: false
 *     |
 *     | (click)
 *     v
 * [EXPANDED] <-- expanded: true, shows input panel to the right
 *     |
 *     | (submit)
 *     v
 * [SENDING] <-- sending: true
 *     |
 *     v
 * [SENT] <-- sent: true (auto-closes after FEEDBACK_SENT_AUTOCLOSE_MS)
 *
 * Clicking outside the button or panel closes the popover.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Megaphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import SidebarTooltip from './SidebarTooltip';
import {
  FEEDBACK_SENT_AUTOCLOSE_MS,
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_EXPANDED,
} from '../config';
import { submitFeedback } from '../hooks';

interface SidebarFeedbackButtonProps {
  isCollapsed: boolean;
}

function useOutsideClose(
  expanded: boolean,
  onClose: () => void,
  refs: Array<React.RefObject<HTMLElement>>,
) {
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideAny = refs.some((r) => r.current?.contains(target));
      if (!insideAny) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expanded, onClose, refs]);
}

interface FeedbackPanelProps {
  panelRef: React.RefObject<HTMLDivElement>;
  isCollapsed: boolean;
  top: number;
  sent: boolean;
  sending: boolean;
  input: string;
  setInput: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

function FeedbackPanel({
  panelRef,
  isCollapsed,
  top,
  sent,
  sending,
  input,
  setInput,
  onSubmit,
  onClose,
}: FeedbackPanelProps) {
  return (
    <div
      ref={panelRef}
      className="fixed z-[100]"
      style={{
        left: isCollapsed ? SIDEBAR_WIDTH_COLLAPSED + 8 : SIDEBAR_WIDTH_EXPANDED + 8,
        top,
      }}
    >
      <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 p-3 w-72">
        {sent ? (
          <p className="text-sm text-green-600 dark:text-green-400">Thank you for your feedback!</p>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Share your thoughts..."
              disabled={sending}
              autoFocus
              className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !sending) onSubmit();
                if (e.key === 'Escape') onClose();
              }}
            />
            <Button
              size="sm"
              onClick={onSubmit}
              disabled={sending || !input.trim()}
              className="w-full"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SidebarFeedbackButton({ isCollapsed }: SidebarFeedbackButtonProps) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [position, setPosition] = useState<{ top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setExpanded(false);
    setSent(false);
  };

  useOutsideClose(expanded, close, [buttonRef, panelRef]);

  const handleSubmit = async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await submitFeedback(trimmed);
      setSent(true);
      setInput('');
      setTimeout(close, FEEDBACK_SENT_AUTOCLOSE_MS);
    } catch (err) {
      console.error('Feedback error:', err);
    } finally {
      setSending(false);
    }
  };

  const handleToggle = () => {
    if (!expanded && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({ top: rect.top });
    }
    setExpanded(!expanded);
    setSent(false);
  };

  return (
    <>
      <SidebarTooltip label="Feedback" isCollapsed={isCollapsed}>
        <button
          ref={buttonRef}
          onClick={handleToggle}
          className={cn(
            'w-full flex items-center gap-3 rounded-lg text-sm transition-all duration-200',
            'hover:bg-gray-100 dark:hover:bg-zinc-800',
            expanded && 'bg-gray-100 dark:bg-zinc-800',
            isCollapsed ? 'justify-center p-2.5 mx-auto' : 'px-3 py-2.5',
          )}
        >
          <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
            <Megaphone className="h-4 w-4" />
          </span>
          {!isCollapsed && <span className="truncate">Feedback</span>}
        </button>
      </SidebarTooltip>

      {expanded && position && (
        <FeedbackPanel
          panelRef={panelRef}
          isCollapsed={isCollapsed}
          top={position.top}
          sent={sent}
          sending={sending}
          input={input}
          setInput={setInput}
          onSubmit={() => void handleSubmit()}
          onClose={close}
        />
      )}
    </>
  );
}
