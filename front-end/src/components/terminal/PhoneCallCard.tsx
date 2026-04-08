import { useState, useEffect, useRef, memo } from 'react';
import { cn } from '@/lib/utils';
import { Phone, Play, Pause, Volume2, VolumeX, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Phone call metadata from agent
export interface PhoneCallMetadata {
  status: 'initiating' | 'in-progress' | 'ended' | 'error';
  to: string;
  callId?: string;
  listenUrl?: string;
  startedAt?: string;
  duration?: number;
  endedReason?: string;
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  structuredData?: Record<string, unknown>;
  error?: string;
}

interface PhoneCallCardProps {
  phoneCall: PhoneCallMetadata;
  toolStatus: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  onTypingComplete?: () => void;
}

// Timer component that ticks every second
const CallTimer = memo(function CallTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startTime = new Date(startedAt).getTime();

    const updateElapsed = () => {
      const now = Date.now();
      setElapsed(Math.floor((now - startTime) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [startedAt]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <span className="tabular-nums font-mono text-sm">
      {minutes}:{seconds.toString().padStart(2, '0')}
    </span>
  );
});

// Audio wave animation
const AudioWave = memo(function AudioWave({ isActive }: { isActive: boolean }) {
  return (
    <div className="flex items-center gap-0.5 h-4">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className={cn(
            'w-0.5 bg-green-500 rounded-full transition-all duration-150',
            isActive ? 'animate-pulse' : 'h-1',
          )}
          style={{
            height: isActive ? `${8 + Math.random() * 8}px` : '4px',
            animationDelay: `${i * 100}ms`,
          }}
        />
      ))}
    </div>
  );
});

// Recording player for completed calls
const RecordingPlayer = memo(function RecordingPlayer({ recordingUrl }: { recordingUrl: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleDurationChange = () => setDuration(audio.duration);
    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('ended', handleEnded);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    setIsPlaying(!isPlaying);
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
      <audio ref={audioRef} src={recordingUrl} preload="metadata" />

      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={togglePlay}>
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>

      <div className="flex-1 flex items-center gap-2">
        <div
          className="flex-1 h-2 bg-muted rounded-full overflow-hidden cursor-pointer relative group"
          onClick={(e) => {
            const audio = audioRef.current;
            if (!audio || !duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const percentage = clickX / rect.width;
            audio.currentTime = percentage * duration;
          }}
        >
          <div
            className="h-full bg-primary transition-all duration-100"
            style={{ width: `${progress}%` }}
          />
          {/* Hover indicator */}
          <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
});

// Main phone call card component
export const PhoneCallCard = memo(function PhoneCallCard({
  phoneCall,
  toolStatus,
  onTypingComplete,
}: PhoneCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Signal typing complete immediately since we don't animate text
  useEffect(() => {
    if (onTypingComplete) {
      requestAnimationFrame(() => {
        onTypingComplete();
      });
    }
  }, [onTypingComplete]);

  // Live audio connection for in-progress calls
  // Vapi sends raw PCM audio: mono, signed 16-bit little-endian (sample rate TBD)
  useEffect(() => {
    if (phoneCall.status !== 'in-progress' || !phoneCall.listenUrl || isMuted) {
      // Clean up if not needed
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      return;
    }

    // Connect to WebSocket for live audio
    try {
      const ws = new WebSocket(phoneCall.listenUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // Create AudioContext for playback (use browser default sample rate)
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      // Try 16kHz stereo (extract left channel only)
      const VAPI_SAMPLE_RATE = 16000;

      // Resume AudioContext (required after user interaction)
      audioContext.resume();

      // Track next play time for seamless audio queuing
      let nextPlayTime = 0;

      ws.onmessage = async (event) => {
        if (!audioContextRef.current || audioContextRef.current.state !== 'running') return;

        try {
          // Data is 1280 bytes = 640 PCM16 samples arriving every ~40ms
          // If stereo at 16kHz: 640 samples = 320 stereo frames = 320/16000 = 20ms
          // But chunks arrive every ~40ms, so likely mono 16kHz: 640/16000 = 40ms ✓
          // Trying stereo deinterleave to see if it fixes graininess
          const pcmData = new Int16Array(event.data);
          const samplesPerChannel = pcmData.length / 2;
          const leftChannel = new Float32Array(samplesPerChannel);
          const rightChannel = new Float32Array(samplesPerChannel);

          // Deinterleave stereo: [L0, R0, L1, R1, ...] -> [L0, L1, ...], [R0, R1, ...]
          for (let i = 0; i < samplesPerChannel; i++) {
            leftChannel[i] = pcmData[i * 2] / 32768;
            rightChannel[i] = pcmData[i * 2 + 1] / 32768;
          }

          // Create stereo audio buffer at 16kHz
          const audioBuffer = audioContextRef.current.createBuffer(
            2,
            samplesPerChannel,
            VAPI_SAMPLE_RATE,
          );
          audioBuffer.getChannelData(0).set(leftChannel);
          audioBuffer.getChannelData(1).set(rightChannel);

          const source = audioContextRef.current.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioContextRef.current.destination);

          // Schedule seamlessly after previous chunk
          const currentTime = audioContextRef.current.currentTime;
          if (nextPlayTime < currentTime) {
            // We've fallen behind, reset to now with small buffer
            nextPlayTime = currentTime + 0.05;
          }
          source.start(nextPlayTime);
          nextPlayTime += audioBuffer.duration;
        } catch (err) {
          console.error('Audio playback error:', err);
        }
      };

      ws.onopen = () => {
        console.log('Live audio WebSocket connected');
      };

      ws.onerror = (err) => {
        console.error('WebSocket error for live audio:', err);
      };

      ws.onclose = () => {
        console.log('Live audio WebSocket closed');
      };

      return () => {
        ws.close();
        audioContextRef.current?.close();
        audioContextRef.current = null;
      };
    } catch (err) {
      console.error('Failed to connect to live audio:', err);
    }
  }, [phoneCall.status, phoneCall.listenUrl, isMuted]);

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
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-3 p-3 cursor-pointer',
          isFinished && 'hover:bg-muted/50',
        )}
        onClick={() => isFinished && setIsExpanded(!isExpanded)}
      >
        {/* Icon with pulse for in-progress */}
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

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{phoneCall.to}</span>
            {isInProgress && phoneCall.startedAt && (
              <>
                <span className="text-muted-foreground">•</span>
                <CallTimer startedAt={phoneCall.startedAt} />
              </>
            )}
            {isFinished && phoneCall.duration != null && phoneCall.duration > 0 && (
              <>
                <span className="text-muted-foreground">•</span>
                <span className="text-sm text-muted-foreground">
                  {Math.floor(phoneCall.duration / 60)}:
                  {(phoneCall.duration % 60).toString().padStart(2, '0')}
                </span>
              </>
            )}
          </div>

          {/* Status text */}
          <div className="text-xs text-muted-foreground">
            {isInProgress && 'Call in progress...'}
            {isFinished && phoneCall.endedReason && `Ended: ${phoneCall.endedReason}`}
            {isError && phoneCall.error}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Live audio controls for in-progress */}
          {isInProgress && phoneCall.listenUrl && (
            <>
              <AudioWave isActive={!isMuted} />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMuted(!isMuted);
                }}
              >
                {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </Button>
            </>
          )}

          {/* Expand chevron for finished calls */}
          {isFinished && (
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>

      {/* Expanded content for finished calls */}
      {isFinished && isExpanded && (
        <div className="border-t p-3 space-y-3">
          {/* Recording player */}
          {phoneCall.recordingUrl && <RecordingPlayer recordingUrl={phoneCall.recordingUrl} />}

          {/* Summary */}
          {phoneCall.summary && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Summary
              </div>
              <p className="text-sm font-medium">{phoneCall.summary}</p>
            </div>
          )}

          {/* Structured data */}
          {phoneCall.structuredData && Object.keys(phoneCall.structuredData).length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Extracted Data
              </div>
              <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto">
                {JSON.stringify(phoneCall.structuredData, null, 2)}
              </pre>
            </div>
          )}

          {/* Transcript */}
          {phoneCall.transcript && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Transcript
              </div>
              <div className="text-sm whitespace-pre-wrap bg-muted/30 p-2 rounded max-h-48 overflow-y-auto">
                {phoneCall.transcript}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default PhoneCallCard;
