import { useInView } from 'react-intersection-observer';

const LAZY_LOAD_ROOT_MARGIN = '600px';
const PLAYBACK_ROOT_MARGIN = '100px';
const PLAYBACK_THRESHOLD = 0.15;

interface CardInViewRefs {
  wrapperRef: (node: HTMLDivElement | null) => void;
  /** True once the wrapper has come within 600px of the viewport (latched). */
  lazyLoadInView: boolean;
  /** True while the wrapper is visibly on-screen (drives play/pause). */
  playbackInView: boolean;
}

/**
 * Two IntersectionObservers per card:
 *   1. Lazy-load gate (triggerOnce, wide 600px margin) — when true we
 *      attach the <source> so the webm actually downloads.
 *   2. Playback gate (threshold 0.15) — flips false when the user
 *      scrolls away so we can pause decoding.
 * Returns a merged ref callback that feeds both observers.
 */
export function useCardInViewRefs(): CardInViewRefs {
  const { ref: lazyLoadRef, inView: lazyLoadInView } = useInView({
    rootMargin: LAZY_LOAD_ROOT_MARGIN,
    triggerOnce: true,
  });
  const { ref: playbackRef, inView: playbackInView } = useInView({
    rootMargin: PLAYBACK_ROOT_MARGIN,
    threshold: PLAYBACK_THRESHOLD,
  });

  const wrapperRef = (node: HTMLDivElement | null) => {
    lazyLoadRef(node);
    playbackRef(node);
  };

  return { wrapperRef, lazyLoadInView, playbackInView };
}
