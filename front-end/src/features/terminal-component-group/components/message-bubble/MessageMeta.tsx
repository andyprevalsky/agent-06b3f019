/**
 * Shared chat-message record pieces: the hover/focus copy button and the
 * agent message meta line (send time + copy), mirroring the user bubble's line.
 *
 * COPY BUTTON STATE MACHINE:
 *   [HIDDEN] --hover of the enclosing `group/message` or keyboard focus--> [SHOWN]
 *   [SHOWN] --click, write succeeds--> [COPIED] (checkmark + "Copied") --2s--> [SHOWN]
 *   [SHOWN] --click, write fails--> toast "Could not copy message", stays [SHOWN]
 *
 * AGENT META LINE: "<local send time (formatMessageSentAt)> [copy]", left-aligned.
 * The caller renders it only for a settled message, never a live stream.
 */
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/hooks/use-toast';
import { copyToClipboard } from '@/lib/clipboard';
import { formatMessageSentAt } from '@/lib/localDateTime';

export function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await copyToClipboard(text);
      setCopied(true);
    } catch {
      toast({ title: 'Could not copy message', variant: 'destructive' });
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={copied ? 'Copied' : 'Copy message'}
            onClick={() => void copy()}
            className="pointer-events-none opacity-0 group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 inline-flex min-h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
            <span aria-live="polite">{copied ? 'Copied' : ''}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{copied ? 'Copied' : 'Copy'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function AgentMessageMeta({ text, sentAt }: { text: string; sentAt: string }) {
  return (
    <div
      data-testid="agent-message-meta"
      className="-mt-1 flex items-center gap-2 text-xs text-muted-foreground"
    >
      <time dateTime={sentAt}>{formatMessageSentAt(sentAt)}</time>
      {text && <CopyMessageButton key={text} text={text} />}
    </div>
  );
}
