/**
 * useVideoPrefetch — background-prefetches the master video as a Blob and
 * swaps the <video> element to the resulting object URL.
 *
 * Platform flags (HEVC / iOS-Safari) are written to the provided control refs
 * so other hooks (state machine, layout) can read them synchronously.
 */

import { useEffect, useRef, useState, type RefObject, type MutableRefObject } from 'react';

import { prefetchVideoBlobUrl } from '../api';
import { MASTER_SRC_HEVC, MASTER_SRC_WEBM } from '../config';
import { detectPlatform } from './stage-helpers';

export interface VideoPrefetchOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  isHevcRef: MutableRefObject<boolean>;
  isIOSSafariRef: MutableRefObject<boolean>;
}

export function useVideoPrefetch(options: VideoPrefetchOptions): string | null {
  const { videoRef, isHevcRef, isIOSSafariRef } = options;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const { isSafari, isIOS } = detectPlatform(navigator.userAgent);
    const sourceUrl = isSafari || isIOS ? MASTER_SRC_HEVC : MASTER_SRC_WEBM;
    isHevcRef.current = isSafari || isIOS;
    isIOSSafariRef.current = isSafari && isIOS;

    let aborted = false;
    void (async () => {
      try {
        const url = await prefetchVideoBlobUrl(sourceUrl);
        if (!url || aborted) return;
        blobUrlRef.current = url;
        setBlobUrl(url);
        video.src = url;
        video.preload = 'auto';
        try {
          video.load();
        } catch {
          // ignore — some browsers throw when load() runs before metadata
        }
        try {
          await video.play();
        } catch {
          // autoplay policies may block — not fatal
        }
      } catch {
        // swallow — background prefetch is best-effort
      }
    })();

    return () => {
      aborted = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [videoRef, isHevcRef, isIOSSafariRef]);

  return blobUrl;
}
