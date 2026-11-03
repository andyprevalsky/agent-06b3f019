/**
 * Release detached media, retaining only weak-keyed primitive playback state
 * for React Suspense to restore when the same host node becomes visible.
 */
import { useCallback, useRef } from 'react';

interface MediaSnapshot {
  src: string;
  time: number;
  paused: boolean;
  rate: number;
}
interface PendingRestore {
  src: string;
  metadata: (event: Event) => void;
}

export function useMediaElementResource<T extends HTMLMediaElement>() {
  const mediaRef = useRef<T | null>(null);
  const snapshotsRef = useRef(new WeakMap<T, MediaSnapshot>());
  const pendingRef = useRef<PendingRestore | null>(null);
  const generationRef = useRef(0);
  const setMediaRef = useCallback((element: T | null) => {
    const previous = mediaRef.current;
    if (previous === element) return;
    const generation = ++generationRef.current;
    const pending = pendingRef.current;
    pendingRef.current = null;
    mediaRef.current = element;
    if (previous) {
      if (pending) previous.removeEventListener('loadedmetadata', pending.metadata, true);
      const src = previous.getAttribute('src');
      // A second hide before metadata must preserve the original playback state.
      if (src !== null && !(pending?.src === src && snapshotsRef.current.has(previous))) {
        snapshotsRef.current.set(previous, {
          src,
          time: previous.currentTime,
          paused: previous.paused,
          rate: previous.playbackRate,
        });
      }
      previous.pause();
      previous.removeAttribute('src');
      previous.load();
    }
    if (!element) return;
    const saved = snapshotsRef.current.get(element);
    if (!saved) return;
    if (element.hasAttribute('src')) {
      snapshotsRef.current.delete(element);
      return;
    }
    const restore = (event?: Event) => {
      const target = (event?.currentTarget ?? mediaRef.current) as T | null;
      if (!target) return;
      target.removeEventListener('loadedmetadata', metadata, true);
      if (pendingRef.current?.metadata === metadata) pendingRef.current = null;
      if (
        snapshotsRef.current.get(target) !== saved ||
        mediaRef.current !== target ||
        generationRef.current !== generation
      )
        return;
      snapshotsRef.current.delete(target);
      if (target.getAttribute('src') !== saved.src) return;
      target.playbackRate = saved.rate;
      if (Number.isFinite(saved.time)) target.currentTime = saved.time;
      if (saved.paused) target.pause();
      else void target.play().catch(() => {});
    };
    const metadata = (event: Event) => restore(event);
    pendingRef.current = { src: saved.src, metadata };
    // Run before React's bubble metadata handler; its intentional seek stays last.
    element.addEventListener('loadedmetadata', metadata, true);
    element.setAttribute('src', saved.src);
    // Suppress autoplay until the saved paused/playing state can be restored.
    element.pause();
    if (element.readyState >= 1) restore();
  }, []);
  return { mediaRef, setMediaRef };
}
