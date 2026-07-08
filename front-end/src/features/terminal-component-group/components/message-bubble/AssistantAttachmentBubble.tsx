/**
 * ASSISTANT messages that carry a file attachment (output files from Claude
 * Code, screenshots, etc.). Rendered left-aligned without avatar / label.
 *
 * STATE MACHINE:
 * [NO FILE]     -> null
 * [TEXT + FILE] -> text bubble plus full-width AttachmentDisplay
 * [FILE ONLY]   -> full-width AttachmentDisplay
 */
import { cn } from '@/lib/utils';
import type { Message } from '../../hooks';
import { roleConfig } from './constants';
import { AttachmentDisplay } from './AttachmentDisplay';

interface AssistantAttachmentBubbleProps {
  message: Message;
  agentId?: string;
}

export function AssistantAttachmentBubble({ message, agentId }: AssistantAttachmentBubbleProps) {
  const config = roleConfig.ASSISTANT;
  if (!message.file_pointer) return null;
  const attachments = [message.file_pointer];

  return (
    <div className="flex w-full flex-col items-start gap-2 animate-in fade-in duration-300">
      {message.text && (
        <div
          className={cn(
            'inline-block max-w-[80%] px-4 py-2 rounded-lg border',
            config.bg,
            config.border,
          )}
        >
          <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
        </div>
      )}
      <AttachmentDisplay attachments={attachments} agentId={agentId} />
    </div>
  );
}
