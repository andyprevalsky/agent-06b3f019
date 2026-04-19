import { Phone, Volume2, VolumeX, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PhoneCallMetadata } from '../../types';
import { AudioWave } from './AudioWave';
import { CallTimer } from './CallTimer';
import { formatOptionalDuration } from './formatDuration';

interface PhoneCallHeaderProps {
  phoneCall: PhoneCallMetadata;
  isInProgress: boolean;
  isFinished: boolean;
  isError: boolean;
  isExpanded: boolean;
  isMuted: boolean;
  onToggleExpanded: () => void;
  onToggleMuted: () => void;
}

/**
 * Compact header row for a phone call: phone icon, phone number, timer or
 * duration, status text, mute + expand controls.
 */
export function PhoneCallHeader(props: PhoneCallHeaderProps) {
  const { isFinished, onToggleExpanded } = props;
  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 cursor-pointer',
        isFinished && 'hover:bg-muted/50',
      )}
      onClick={() => isFinished && onToggleExpanded()}
    >
      <StatusIcon {...props} />
      <HeaderContent {...props} />
      <HeaderActions {...props} />
    </div>
  );
}

function StatusIcon({
  isInProgress,
  isFinished,
  isError,
}: Pick<PhoneCallHeaderProps, 'isInProgress' | 'isFinished' | 'isError'>) {
  return (
    <div
      className={cn(
        'w-8 h-8 rounded-full flex items-center justify-center shrink-0',
        isInProgress && 'bg-green-500/20 animate-pulse',
        isFinished && 'bg-muted',
        isError && 'bg-red-500/20',
      )}
    >
      <Phone
        className={cn(
          'h-4 w-4',
          isInProgress && 'text-green-500',
          isFinished && 'text-muted-foreground',
          isError && 'text-red-500',
        )}
      />
    </div>
  );
}

function HeaderContent({
  phoneCall,
  isInProgress,
  isFinished,
  isError,
}: Pick<PhoneCallHeaderProps, 'phoneCall' | 'isInProgress' | 'isFinished' | 'isError'>) {
  const durationText = formatOptionalDuration(phoneCall.duration);
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm truncate">{phoneCall.to}</span>
        {isInProgress && phoneCall.startedAt && (
          <>
            <span className="text-muted-foreground">•</span>
            <CallTimer startedAt={phoneCall.startedAt} />
          </>
        )}
        {isFinished && durationText && (
          <>
            <span className="text-muted-foreground">•</span>
            <span className="text-sm text-muted-foreground">{durationText}</span>
          </>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {isInProgress && 'Call in progress...'}
        {isFinished && phoneCall.endedReason && `Ended: ${phoneCall.endedReason}`}
        {isError && phoneCall.error}
      </div>
    </div>
  );
}

function HeaderActions({
  phoneCall,
  isInProgress,
  isFinished,
  isExpanded,
  isMuted,
  onToggleMuted,
}: Pick<
  PhoneCallHeaderProps,
  'phoneCall' | 'isInProgress' | 'isFinished' | 'isExpanded' | 'isMuted' | 'onToggleMuted'
>) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {isInProgress && phoneCall.listenUrl && (
        <>
          <AudioWave isActive={!isMuted} />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMuted();
            }}
          >
            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
        </>
      )}
      {isFinished && (
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      )}
    </div>
  );
}
