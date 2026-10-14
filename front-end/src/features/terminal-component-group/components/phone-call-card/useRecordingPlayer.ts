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
 */
export function useRecordingPlayer(src: string | null): RecordingPlayerState {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) {
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      return;
    }

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleDurationChange = () =>
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [src]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play();
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
