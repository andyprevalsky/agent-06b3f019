import { useEffect, type RefObject } from 'react';

const RECOVERY_DELAY_MS = 100;

function recoverVideo(video: HTMLVideoElement): void {
  if (!video.paused) return;
  const currentTime = video.currentTime;
  video.load();
  video.currentTime = currentTime;
  setTimeout(() => {
    video.play().catch(() => {
      /* Autoplay failure is expected on iOS until user gesture. */
    });
  }, RECOVERY_DELAY_MS);
}

function pauseVideo(video: HTMLVideoElement): void {
  if (!video.paused) video.pause();
}

/**
 * Handles iOS Safari's aggressive video-freezing behavior on tab
 * switches, BFCache restores, and focus/blur transitions. When the
 * page regains focus we reload+replay both videos; when it loses
 * focus we pause to avoid stale/frozen frames.
 */
export function useIOSSafariRecovery(
  blackVideoRef: RefObject<HTMLVideoElement>,
  whiteVideoRef: RefObject<HTMLVideoElement>,
): void {
  useEffect(() => {
    const black = blackVideoRef.current;
    const white = whiteVideoRef.current;
    if (!black || !white) return;

    const playBoth = () => {
      recoverVideo(black);
      recoverVideo(white);
    };

    const pauseBoth = () => {
      pauseVideo(black);
      pauseVideo(white);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) pauseBoth();
      else playBoth();
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) playBoth();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', playBoth);
    window.addEventListener('blur', pauseBoth);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', playBoth);
      window.removeEventListener('blur', pauseBoth);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [blackVideoRef, whiteVideoRef]);
}
