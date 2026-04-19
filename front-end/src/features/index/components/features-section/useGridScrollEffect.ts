import { useEffect, useState, type RefObject } from 'react';

interface GridScrollEffect {
  featuresClipPath: string;
  gridOffsetX: number;
}

/**
 * Drives the 3D-grid background reveal and horizontal parallax.
 * Computes `clip-path` and `background-position-x` from scroll.
 */
export function useGridScrollEffect(sectionRef: RefObject<HTMLDivElement>): GridScrollEffect {
  const [featuresClipPath, setFeaturesClipPath] = useState('inset(99% 0% 0% 0%)');
  const [gridOffsetX, setGridOffsetX] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      const sectionElement = sectionRef.current;
      if (!sectionElement) return;
      const sectionRect = sectionElement.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const sectionHeight = sectionElement.offsetHeight || 1;

      const isSmall = window.matchMedia('(max-width: 1024px)').matches;
      const preRevealPx = viewportHeight * (isSmall ? 0.6 : 0.25);
      const topClip = (Math.max(0, sectionRect.top - preRevealPx) / viewportHeight) * 100;
      const bottomClip = (Math.max(0, viewportHeight - sectionRect.bottom) / viewportHeight) * 100;
      setFeaturesClipPath(`inset(${topClip}% 0% ${bottomClip}% 0%)`);

      const scrolledWithin = Math.min(Math.max(-sectionRect.top, 0), sectionHeight);
      const progress = scrolledWithin / sectionHeight;
      const offset = progress * 1200 + window.scrollY * 0.1;
      setGridOffsetX(offset);
    };

    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        handleScroll();
        rafId = 0;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    handleScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [sectionRef]);

  return { featuresClipPath, gridOffsetX };
}
