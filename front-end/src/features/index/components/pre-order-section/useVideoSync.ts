import { useEffect, type RefObject } from 'react';

interface UseVideoSyncArgs {
  isSafari: boolean;
  blackVideoRef: RefObject<HTMLVideoElement>;
  whiteVideoRef: RefObject<HTMLVideoElement>;
  blackInView: boolean;
  whiteInView: boolean;
}

/** Wait until a video has enough data to play. */
function waitUntilPlayable(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (video.readyState >= 3) {
      resolve();
      return;
    }
    video.addEventListener('canplay', () => resolve(), { once: true });
  });
}

async function syncPair(black: HTMLVideoElement, white: HTMLVideoElement): Promise<void> {
  black.currentTime = 0;
  white.currentTime = 0;
  await Promise.all([waitUntilPlayable(black), waitUntilPlayable(white)]);
  black.pause();
  white.pause();
  black.currentTime = 0;
  white.currentTime = 0;
  await Promise.all([black.play(), white.play()]);
}

/**
 * Once both videos are in view (and we're not on Safari, which gets
 * a static poster instead), reset both to t=0 and play them
 * simultaneously so the black/white animations stay in lock-step.
 */
export function useVideoSync({
  isSafari,
  blackVideoRef,
  whiteVideoRef,
  blackInView,
  whiteInView,
}: UseVideoSyncArgs): void {
  useEffect(() => {
    if (isSafari) return;
    const black = blackVideoRef.current;
    const white = whiteVideoRef.current;
    if (!black || !white || !blackInView || !whiteInView) return;

    syncPair(black, white).catch(() => {
      // Autoplay policies / cross-browser quirks can reject play(); the
      // per-video visibility effect will retry playback when the user
      // scrolls the card into view.
    });
  }, [isSafari, blackVideoRef, whiteVideoRef, blackInView, whiteInView]);
}
