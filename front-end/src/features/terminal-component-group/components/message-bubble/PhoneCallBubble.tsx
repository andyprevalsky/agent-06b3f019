/**
 * call_phone_number tool → PhoneCallCard.
 */
import { useAgentContext } from '@/features/agent-context';
import type { Message } from '../../hooks';
import type { PhoneCallMetadata } from '../../types';
import { PhoneCallCard } from '../PhoneCallCard';

interface PhoneCallBubbleProps {
  message: Message;
  onTypingComplete?: () => void;
}

export function PhoneCallBubble({ message, onTypingComplete }: PhoneCallBubbleProps) {
  const { selectedAgentId } = useAgentContext();
  const toolStatus = ((message.metadata?.toolStatus as string | undefined) || 'IN_PROGRESS') as
    'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  const phoneCallMetadata = message.metadata?.phoneCall as PhoneCallMetadata | undefined;

  const phoneCall: PhoneCallMetadata =
    phoneCallMetadata ??
    ({
      status:
        toolStatus === 'IN_PROGRESS'
          ? 'in-progress'
          : toolStatus === 'FINISHED'
            ? 'ended'
            : 'error',
      to:
        ((message.metadata?.title as string | undefined) || '')
          .replace(/[\u{1F4DE}\u{2705}\u{274C}]\s*/gu, '')
          .trim() || 'Unknown',
    } as PhoneCallMetadata);

  return (
    <div className="animate-in fade-in duration-300">
      <PhoneCallCard
        phoneCall={phoneCall}
        toolStatus={toolStatus}
        agentId={selectedAgentId}
        onTypingComplete={onTypingComplete}
      />
    </div>
  );
}
