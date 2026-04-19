import { useState, useEffect, memo } from 'react';
import { cn } from '@/lib/utils';
import type { PhoneCallMetadata } from '../types';
import { PhoneCallDetails } from './phone-call-card/PhoneCallDetails';
import { PhoneCallHeader } from './phone-call-card/PhoneCallHeader';
import { useLiveAudio } from './phone-call-card/useLiveAudio';

export type { PhoneCallMetadata } from '../types';

interface PhoneCallCardProps {
  phoneCall: PhoneCallMetadata;
  toolStatus: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  onTypingComplete?: () => void;
}

/**
 * Card showing a single phone-call tool invocation. While the call is live it
 * shows a timer and streams the audio; once ended it becomes expandable to
 * reveal the recording, summary, extracted data, and transcript.
 */
export const PhoneCallCard = memo(function PhoneCallCard({
  phoneCall,
  toolStatus,
  onTypingComplete,
}: PhoneCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMuted, setIsMuted] = useState(true);

  useEffect(() => {
    if (onTypingComplete) {
      requestAnimationFrame(() => {
        onTypingComplete();
      });
    }
  }, [onTypingComplete]);

  useLiveAudio({
    status: phoneCall.status,
    listenUrl: phoneCall.listenUrl,
    isMuted,
  });

  const isInProgress = toolStatus === 'IN_PROGRESS' || phoneCall.status === 'in-progress';
  const isFinished = toolStatus === 'FINISHED' || phoneCall.status === 'ended';
  const isError = toolStatus === 'ERROR' || phoneCall.status === 'error';

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden transition-all duration-200',
        isInProgress && 'border-green-500/50 bg-green-500/5',
        isFinished && 'border-border bg-card',
        isError && 'border-red-500/50 bg-red-500/5',
      )}
    >
      <PhoneCallHeader
        phoneCall={phoneCall}
        isInProgress={isInProgress}
        isFinished={isFinished}
        isError={isError}
        isExpanded={isExpanded}
        isMuted={isMuted}
        onToggleExpanded={() => setIsExpanded(!isExpanded)}
        onToggleMuted={() => setIsMuted(!isMuted)}
      />

      {isFinished && isExpanded && <PhoneCallDetails phoneCall={phoneCall} />}
    </div>
  );
});

export default PhoneCallCard;
