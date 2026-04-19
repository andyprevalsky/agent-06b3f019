import { useEffect, type RefObject } from 'react';

/**
 * Plays/pauses the video as it crosses the viewport. Uses the
 * `inView` signal from react-intersection-observer so we don't
 * burn CPU decoding frames for an off-screen video.
 */
export function useVideoVisibilityPlayback(
  videoRef: RefObject<HTMLVideoElement>,
  inView: boolean,
): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (inView) {
      video.play().catch(() => {
        /* Autoplay may be blocked until user interaction; ignore. */
      });
    } else {
      video.pause();
    }
  }, [videoRef, inView]);
}
