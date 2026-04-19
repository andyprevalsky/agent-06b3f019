/**
 * wait_for tool message → WaitForChip with grouped check history.
 */
import type { ComponentProps } from 'react';
import type { Message } from '../../hooks';
import type { WaitForCheck } from '../../types';
import WaitForChip from '../WaitForChip';

type WaitForChipMetadata = ComponentProps<typeof WaitForChip>['metadata'];

interface WaitForBubbleProps {
  message: Message;
  waitForChecks?: WaitForCheck[];
  onTypingComplete?: () => void;
}

export function WaitForBubble({ message, waitForChecks, onTypingComplete }: WaitForBubbleProps) {
  const metadata = message.metadata;
  const toolStatus = (metadata?.toolStatus as string) || 'IN_PROGRESS';
  const checkHistory = waitForChecks || [];
  return (
    <WaitForChip
      title={(metadata?.title as string) || ''}
      message={message.text || ''}
      status={toolStatus as 'IN_PROGRESS' | 'FINISHED' | 'ERROR'}
      checks={checkHistory}
      metadata={metadata as unknown as WaitForChipMetadata}
      startTimestamp={message.timestamp}
      onTypingComplete={onTypingComplete}
    />
  );
}
