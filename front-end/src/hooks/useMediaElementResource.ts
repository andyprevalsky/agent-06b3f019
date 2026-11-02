/**
 * Media attachment lifecycle: attached -> playing/paused -> detached -> unloaded.
 * A detached video can retain its decoder, byte buffers and playback. Release
 * the captured element in its ref cleanup, before losing access to that node.
 */
import { useCallback, useRef } from 'react';

export function useMediaElementResource<T extends HTMLMediaElement>() {
  const mediaRef = useRef<T | null>(null);
  const setMediaRef = useCallback((element: T | null) => {
    const previous = mediaRef.current;
    mediaRef.current = element;
    if (previous && previous !== element) {
      previous.pause();
      previous.removeAttribute('src');
      previous.load();
    }
  }, []);
  return { mediaRef, setMediaRef };
}
