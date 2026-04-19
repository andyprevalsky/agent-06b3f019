/**
 * useVideoWarmup — forces full buffering by seeking to the end of the video
 * and back once loadedmetadata fires.
 */

import { useEffect, type RefObject } from 'react';

import type { MarkersFile } from '../types';

export function useVideoWarmup(
  videoRef: RefObject<HTMLVideoElement | null>,
  markers: MarkersFile | null,
  disabled: boolean,
): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !markers || disabled) return;

    const forceBuffering = () => {
      const duration = video.duration || 0;
      if (duration > 0) {
        video.currentTime = duration - 0.1;
        setTimeout(() => {
          video.currentTime = 0;
        }, 100);
      }
    };

    const onLoadedMetadata = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      forceBuffering();
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    if (video.readyState >= 1) forceBuffering();

    return () => video.removeEventListener('loadedmetadata', onLoadedMetadata);
  }, [videoRef, markers, disabled]);
}
