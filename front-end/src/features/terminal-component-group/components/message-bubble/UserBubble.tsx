/**
 * Right-aligned USER bubble with optional inline attachment row.
 *
 * A person's message that resumed a stopped agent shows its time and the resume
 * state beneath it (codeAgentResume.ts), from real rows only:
 *   code agent (metadata.codeAgentResume, precomputed by the code-agent view):
 *     "Resuming…" → "Starting container…" → "Delivered" | "Couldn't resume: <reason>"
 *   paused browser (metadata.browserResume): "Resuming…" → "Starting browser…" →
 *     "Delivered" | "Couldn't resume: <reason>" (the browser's rows after it)
 *   Rose agent (metadata.resumedFrom): "Resuming…" → "Delivered" (its next row)
 * The line changes in place, so it is a live region (role="status").
 *
 * A Browser-composer message (metadata.browserTaskId + excludeFromModel) went
 * straight to that browser, not this agent: it reads "You → Browser: …" in the
 * code-agent "You → <agent>" text style.
 */
import { useContext } from 'react';
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
      <ResumeLine message={message} />
    </div>
  );
}

function ResumeLine({ message }: { message: Message }) {
  const messages = useContext(AgentContext)?.messages ?? [];
  const resume =
    (message.metadata?.codeAgentResume as CodeAgentResumeState | undefined) ??
    browserResumeState(messages, message) ??
    roseResumeState(messages, message);
  if (!resume) return null;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <p
      role="status"
      data-testid="code-agent-resume-status"
      data-resume-status={resume.status}
      className={cn(
        'text-xs text-muted-foreground',
        resume.status === 'failed' && 'text-red-500 dark:text-red-400',
      )}
    >
      <time dateTime={message.timestamp}>{time}</time> · {codeAgentResumeLabel(resume)}
    </p>
  );
}
