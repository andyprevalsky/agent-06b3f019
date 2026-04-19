/**
 * Fallback SYSTEM / ASSISTANT bubble (no avatar, no label). Used when none
 * of the specialised MessageBubble routes match.
 */
import { cn } from '@/lib/utils';
import type { Message } from '../../hooks';
import { roleConfig } from './constants';

interface DefaultBubbleProps {
  message: Message;
  isStreaming?: boolean;
}

export function DefaultBubble({ message, isStreaming }: DefaultBubbleProps) {
  const config = roleConfig[message.role];
  return (
    <div className="flex flex-col items-start gap-2 animate-in fade-in duration-300">
      <div
        className={cn(
          'inline-block max-w-[80%] px-4 py-2 rounded-lg border',
          config.bg,
          config.border,
          isStreaming && 'border-purple-500/50',
        )}
      >
        <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
      </div>
    </div>
  );
}
