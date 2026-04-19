import { useEffect, useRef, useState, type RefObject } from 'react';

interface FeatureScrollSpy {
  activeFeature: number;
  setActiveFeature: (index: number) => void;
  pauseScrollSpy: (ms: number) => void;
}

/**
 * Observes per-feature sentinels and updates `activeFeature` based on
 * which sentinel is most centered in the viewport. A click handler can
 * call `pauseScrollSpy(ms)` to temporarily suspend updates during a
 * smooth-scroll so the highlight doesn't flicker.
 */
export function useFeatureScrollSpy(
  sectionRef: RefObject<HTMLDivElement>,
  initialIndex = 0,
): FeatureScrollSpy {
  const [activeFeature, setActiveFeature] = useState(initialIndex);
  const observersReadyRef = useRef(false);
  const scrollSpyPauseUntilRef = useRef<number>(0);

  useEffect(() => {
    if (!sectionRef.current || observersReadyRef.current) return;
    const sectionEl = sectionRef.current;
    const sentinels = Array.from(
      sectionEl.querySelectorAll('[data-sentinel-index]'),
    ) as HTMLElement[];
    if (sentinels.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (performance.now() < scrollSpyPauseUntilRef.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => (b.intersectionRatio || 0) - (a.intersectionRatio || 0));
        if (visible.length === 0) return;
        const idxAttr = (visible[0].target as HTMLElement).getAttribute('data-sentinel-index');
        const idx = idxAttr ? parseInt(idxAttr, 10) : NaN;
        if (!Number.isNaN(idx)) setActiveFeature(idx);
      },
      {
        threshold: [0, 0.25, 0.5, 0.75, 1],
        rootMargin: '-40% 0px -40% 0px',
      },
    );

    sentinels.forEach((s) => observer.observe(s));
    observersReadyRef.current = true;
    return () => observer.disconnect();
  }, [sectionRef]);

  const pauseScrollSpy = (ms: number) => {
    scrollSpyPauseUntilRef.current = performance.now() + ms;
  };

  return { activeFeature, setActiveFeature, pauseScrollSpy };
}
