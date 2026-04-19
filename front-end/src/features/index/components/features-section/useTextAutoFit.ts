import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

interface TextAutoFit {
  textContainerRefs: MutableRefObject<Array<HTMLDivElement | null>>;
  textContentRefs: MutableRefObject<Array<HTMLUListElement | null>>;
  textScales: number[];
}

const MIN_SCALE = 0.85;
const SCALE_STEP = 0.04;
const MAX_ATTEMPTS = 8;

/**
 * Scales typography down (by 4% increments, min 0.85) until the
 * active feature card's text fits inside its container on
 * mobile/tablet. Desktop skips (uses a different layout).
 */
export function useTextAutoFit(activeFeature: number, featureCount: number): TextAutoFit {
  const textContainerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const textContentRefs = useRef<Array<HTMLUListElement | null>>([]);
  const [textScales, setTextScales] = useState<number[]>(() => new Array(featureCount).fill(1));

  useLayoutEffect(() => {
    const isDesktop = window.matchMedia('(min-width: 1024px)').matches;
    if (isDesktop) return;
    const idx = activeFeature;
    const container = textContainerRefs.current[idx];
    const content = textContentRefs.current[idx];
    if (!container || !content) return;

    let scale = 1;
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      content.style.setProperty('--title-scale', String(scale));
      content.style.setProperty('--body-scale', String(scale));
      // Force sync measurement after style change
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      content.offsetHeight;
      const overflows = content.scrollHeight > container.clientHeight;
      if (!overflows || scale <= MIN_SCALE) break;
      scale = Math.max(MIN_SCALE, scale - SCALE_STEP);
      attempts += 1;
    }

    setTextScales((prev) => {
      const next = [...prev];
      next[idx] = scale;
      return next;
    });

    return () => {
      try {
        content.style.removeProperty('--title-scale');
        content.style.removeProperty('--body-scale');
      } catch {
        /* no-op */
      }
    };
  }, [activeFeature]);

  return { textContainerRefs, textContentRefs, textScales };
}
