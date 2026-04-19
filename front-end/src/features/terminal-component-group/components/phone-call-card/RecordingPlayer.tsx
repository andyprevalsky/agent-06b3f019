import { memo } from 'react';
import { Play, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDuration } from './formatDuration';
import { useRecordingPlayer } from './useRecordingPlayer';

/**
 * Inline audio player used for completed (ended) calls. Exposes play/pause,
 * a click-to-seek progress bar, and a time readout.
 */
export const RecordingPlayer = memo(function RecordingPlayer({
  recordingUrl,
}: {
  recordingUrl: string;
}) {
  const { audioRef, isPlaying, currentTime, duration, togglePlay, seekToFraction } =
    useRecordingPlayer();

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    seekToFraction(clickX / rect.width);
  };

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
      <audio ref={audioRef} src={recordingUrl} preload="metadata" />

      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={togglePlay}>
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>

      <div className="flex-1 flex items-center gap-2">
        <div
          className="flex-1 h-2 bg-muted rounded-full overflow-hidden cursor-pointer relative group"
          onClick={handleSeek}
        >
          <div
            className="h-full bg-primary transition-all duration-100"
            style={{ width: `${progress}%` }}
          />
          <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDuration(currentTime)} / {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
});
