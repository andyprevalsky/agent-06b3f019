/**
 * Right-aligned USER bubble with optional inline attachment row.
 *
 * A Browser-composer message (metadata.browserTaskId + excludeFromModel) went
 * straight to that browser, not this agent: it reads "You → Browser: …" in the
 * code-agent "You → <agent>" text style.
 */
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
    </div>
  );
}
