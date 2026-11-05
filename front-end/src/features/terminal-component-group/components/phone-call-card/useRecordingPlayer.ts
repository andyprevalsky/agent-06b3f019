import { useEffect, useRef, useState } from 'react';

interface RecordingPlayerState {
  audioRef: React.RefObject<HTMLAudioElement>;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  togglePlay: () => void;
  seekToFraction: (fraction: number) => void;
}

/**
 * Encapsulates audio playback state (play/pause, current time, seek) for a
 * given recording URL.
 *
 * idle --src set--> ready
 * ready --toggle--> playing | paused
 * playing --ended--> paused
 * source change -> ready (reset counters); unmount -> paused, source released
 */
export function useRecordingPlayer(src: string | null): RecordingPlayerState {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playAttemptRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    playAttemptRef.current += 1;
    const audio = audioRef.current;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (!audio || !src) return;
    // Restore the source after a StrictMode cleanup as well as ordinary mounts.
    if (audio.getAttribute('src') !== src) {
      audio.setAttribute('src', src);
      audio.load();
    }

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleDurationChange = () =>
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('ended', handleEnded);

    return () => {
      playAttemptRef.current += 1;
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('ended', handleEnded);
      audio.pause();
      // React may already have assigned the next source to this same element.
      const current = audio.getAttribute('src');
      if (current === src || !current) {
        audio.removeAttribute('src');
        audio.load();
      }
    };
  }, [src]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const attempt = ++playAttemptRef.current;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play().catch((error: unknown) => {
        if (playAttemptRef.current !== attempt || audioRef.current !== audio) return;
        setIsPlaying(false);
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('Failed to play phone recording:', error);
        }
      });
    }
    setIsPlaying(!isPlaying);
  };

  const seekToFraction = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = fraction * duration;
  };

  return { audioRef, isPlaying, currentTime, duration, togglePlay, seekToFraction };
}
