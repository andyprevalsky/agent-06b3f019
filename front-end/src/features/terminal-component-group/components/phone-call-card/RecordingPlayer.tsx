import { memo, useEffect, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchPhoneCallRecording } from '../../hooks';
import { formatDuration } from './formatDuration';
import { useRecordingPlayer } from './useRecordingPlayer';

interface RecordingPlayerProps {
  agentId?: string | null;
  callId?: string;
  recordingUrl?: string;
}

/**
 * Inline audio player used for completed (ended) calls.
 *
 * idle -> loading (agentId + callId)
 * loading -> ready (first-party blob URL)
 * loading -> error
 * idle -> error when only a private provider URL exists
 * ready -> playing/paused
 *
 * Never use Vapi's private bucket recordingUrl (hipaa-recordings / R2) as
 * <audio src>. Those URLs are not browser-playable.
 */
export const RecordingPlayer = memo(function RecordingPlayer({
  agentId,
  callId,
  recordingUrl,
}: RecordingPlayerProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { audioRef, isPlaying, currentTime, duration, togglePlay, seekToFraction } =
    useRecordingPlayer(src);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    const controller = new AbortController();

    if (agentId && callId) {
      setLoading(true);
      setError(null);
      setSrc(null);
      void fetchPhoneCallRecording(agentId, callId, { signal: controller.signal })
        .then((blob) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSrc(null);
          setLoading(false);
          setError(err instanceof Error ? err.message : 'Failed to load recording');
        });
    } else {
      setSrc(null);
      setLoading(false);
      setError(recordingUrl || callId ? 'Recording is not playable from the provider URL.' : null);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentId, callId, recordingUrl]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    seekToFraction(clickX / rect.width);
  };

  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (loading || !src) {
    return <p className="text-xs text-muted-foreground">Loading recording…</p>;
  }

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
      <audio ref={audioRef} src={src} preload="metadata" />

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
