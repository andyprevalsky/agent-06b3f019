/**
 * Terminal feature — popular goals ticker carousel hook.
 *
 * Runs a constant-speed horizontal scroll animation via requestAnimationFrame.
 */

import { useState, useEffect, useRef } from 'react';

import { TICKER_SPEED_PX_PER_SEC } from '../config';

export function useTickerCarousel(selectedAgentId: string | null) {
  const [tickerOffset, setTickerOffset] = useState(0);
  const tickerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(Date.now());
  useEffect(() => {
    if (selectedAgentId) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const animate = () => {
      const now = Date.now();
      const deltaTime = now - lastTimeRef.current;
      lastTimeRef.current = now;

      setTickerOffset((prev) => {
        if (!tickerRef.current) return prev;

        const newOffset = prev + (TICKER_SPEED_PX_PER_SEC * deltaTime) / 1000;
        const singleSetWidth = tickerRef.current.scrollWidth / 3;

        if (newOffset >= singleSetWidth) {
          return newOffset - singleSetWidth;
        }
        return newOffset;
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [selectedAgentId]);

  return { tickerOffset, tickerRef };
}
