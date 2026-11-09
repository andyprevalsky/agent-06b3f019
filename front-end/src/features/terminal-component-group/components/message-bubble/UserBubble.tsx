/**
 * Right-aligned USER bubble with optional inline attachment row.
 *
 * META LINE (always, under the bubble): the local send time (formatMessageSentAt:
 * day label once before today), with one state to its left:
 *   resume (from real rows only, codeAgentResume.ts; live region, role="status"):
 *     code agent (metadata.codeAgentResume, precomputed by the code-agent view):
 *       "Resuming…" → "Starting container…" → "Delivered" | "Couldn't resume: <reason>"
 *     paused browser (metadata.browserResume): "Resuming…" → "Starting browser…" →
 *       "Delivered" | "Couldn't resume: <reason>" (the browser's rows after it)
 *     Rose agent (metadata.resumedFrom): "Resuming…" → "Delivered" (its next row)
 *   else this browser's own send (metadata.clientDelivery):
 *     [SENDING] "Sending ◌  3:36 PM" --agent's next step picks it up--> "3:36 PM"
 *     (lifecycle: agent-context/hooks/optimisticUserMessages.ts)
 *
 * A Browser-composer message (metadata.browserTaskId + excludeFromModel) went
 * straight to that browser, not this agent: it reads "You → Browser: …" in the
 * code-agent "You → <agent>" text style.
 */
import { useContext } from 'react';
import { formatMessageSentAt } from '@/lib/localDateTime';
import { cn } from '@/lib/utils';
import { AgentContext, type Message } from '../../hooks';
import {
  browserResumeState,
  codeAgentResumeLabel,
  roseResumeState,
  type CodeAgentResumeState,
} from '../../hooks/codeAgentResume';
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
      <MetaLine message={message} />
    </div>
  );
}

function MetaLine({ message }: { message: Message }) {
  const messages = useContext(AgentContext)?.messages ?? [];
  const resume =
    (message.metadata?.codeAgentResume as CodeAgentResumeState | undefined) ??
    browserResumeState(messages, message) ??
    roseResumeState(messages, message);
  const time = <time dateTime={message.timestamp}>{formatMessageSentAt(message.timestamp)}</time>;
  if (resume) {
    return (
      <p
        role="status"
        data-testid="code-agent-resume-status"
        data-resume-status={resume.status}
        className={cn(
          '-mt-1 pr-1 text-xs text-muted-foreground',
          resume.status === 'failed' && 'text-red-500 dark:text-red-400',
        )}
      >
        {time} · {codeAgentResumeLabel(resume)}
      </p>
    );
  }
  return (
    <div
      data-testid="user-message-meta"
      className="-mt-1 flex items-center gap-2 pr-1 text-xs text-muted-foreground"
    >
      {message.metadata?.clientDelivery === 'sending' && (
        <span
          data-testid="user-message-delivery"
          data-delivery-state="sending"
          className="flex items-center gap-1.5"
        >
          Sending
          <span
            aria-hidden
            className="h-3 w-3 motion-safe:animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
          />
        </span>
      )}
      {time}
    </div>
  );
}
