/**
 * useVideoLoadingState — tracks whether a <video> element is currently in a
 * loading/buffering state by listening to its media events.
 */

import { useEffect, useState, type RefObject } from 'react';

const LOADING_EVENTS = ['loadstart', 'waiting', 'stalled'] as const;
const READY_EVENTS = ['canplay', 'canplaythrough', 'playing', 'loadeddata'] as const;

export function useVideoLoadingState(videoRef: RefObject<HTMLVideoElement | null>): boolean {
  const [isVideoLoading, setIsVideoLoading] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const setLoading = () => setIsVideoLoading(true);
    const setReady = () => setIsVideoLoading(false);

    LOADING_EVENTS.forEach((e) => video.addEventListener(e, setLoading));
    READY_EVENTS.forEach((e) => video.addEventListener(e, setReady));

    return () => {
      LOADING_EVENTS.forEach((e) => video.removeEventListener(e, setLoading));
      READY_EVENTS.forEach((e) => video.removeEventListener(e, setReady));
    };
  }, [videoRef]);

  return isVideoLoading;
}
