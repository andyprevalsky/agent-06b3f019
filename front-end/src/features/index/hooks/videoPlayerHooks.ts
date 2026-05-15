import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';

// ---------------------------------------------------------------------------
// Browser detection
// ---------------------------------------------------------------------------

export interface BrowserDetection {
  isSafari: boolean;
  isIOS: boolean;
}

/** Detects Safari and iOS user agents on mount. */
export function useBrowserDetection(): BrowserDetection {
  const [isSafari, setIsSafari] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const safari = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('firefox');
    const ios = /iphone|ipad|ipod/.test(ua);
    setIsSafari(safari);
    setIsIOS(ios);
  }, []);

  return { isSafari, isIOS };
}

// ---------------------------------------------------------------------------
// Deferred load (allows image to paint first)
// ---------------------------------------------------------------------------

/** Defers non-priority videos to the next animation frame. */
export function useDeferredVideoLoad(priority: boolean): boolean {
  const [shouldLoadVideo, setShouldLoadVideo] = useState(priority);

  useEffect(() => {
    if (priority) return;
    const raf = requestAnimationFrame(() => setShouldLoadVideo(true));
    return () => cancelAnimationFrame(raf);
  }, [priority]);

  return shouldLoadVideo;
}

// ---------------------------------------------------------------------------
// Autoplay + first-frame notification
// ---------------------------------------------------------------------------

interface AutoplayHandlers {
  safeAutoplay: () => void;
  maybeNotifyFirstFrame: () => void;
}

function createAutoplayHandlers(
  getVideo: () => HTMLVideoElement | null,
  autoPlay: boolean,
  onFirstFrame?: () => void,
): AutoplayHandlers {
  let hasAttemptedPlay = false;
  let notifiedFirstFrame = false;

  const safeAutoplay = () => {
    const video = getVideo();
    if (!video || !autoPlay || hasAttemptedPlay) return;
    hasAttemptedPlay = true;
    video.muted = true;
    setTimeout(() => {
      video.play().catch((err: unknown) => {
        console.warn('[Autoplay failed]', err);
        hasAttemptedPlay = false;
      });
    }, 0);
  };

  const maybeNotifyFirstFrame = () => {
    const video = getVideo();
    if (!video || notifiedFirstFrame) return;
    if (video.currentTime > 0 || video.readyState >= 2) {
      notifiedFirstFrame = true;
      onFirstFrame?.();
    }
  };

  return { safeAutoplay, maybeNotifyFirstFrame };
}

/** Wires up lifecycle listeners to autoplay the video & notify first frame. */
export function useVideoAutoplay(
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  shouldLoadVideo: boolean,
  autoPlay: boolean,
  onLoad?: () => void,
  onFirstFrame?: () => void,
): void {
  useEffect(() => {
    if (!shouldLoadVideo) return;
    const video = videoRef.current;
    if (!video) return;

    const { safeAutoplay, maybeNotifyFirstFrame } = createAutoplayHandlers(
      () => videoRef.current,
      autoPlay,
      onFirstFrame,
    );

    const handleVideoLoad = () => {
      safeAutoplay();
      onLoad?.();
      maybeNotifyFirstFrame();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') safeAutoplay();
    };

    video.addEventListener('loadeddata', handleVideoLoad);
    video.addEventListener('playing', maybeNotifyFirstFrame);
    video.addEventListener('timeupdate', maybeNotifyFirstFrame);
    window.addEventListener('load', safeAutoplay);
    window.addEventListener('pageshow', safeAutoplay);
    window.addEventListener('focus', safeAutoplay);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('DOMContentLoaded', safeAutoplay);

    if (video.readyState >= 2) safeAutoplay();

    return () => {
      video.removeEventListener('loadeddata', handleVideoLoad);
      video.removeEventListener('playing', maybeNotifyFirstFrame);
      video.removeEventListener('timeupdate', maybeNotifyFirstFrame);
      window.removeEventListener('load', safeAutoplay);
      window.removeEventListener('pageshow', safeAutoplay);
      window.removeEventListener('focus', safeAutoplay);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('DOMContentLoaded', safeAutoplay);
    };
    // videoRef is a stable MutableRefObject — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoadVideo, autoPlay, onLoad, onFirstFrame]);
}
