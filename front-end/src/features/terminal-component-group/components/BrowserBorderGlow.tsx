/**
 * BrowserBorderGlow - Canvas overlay with flickering dot grid animation
 *
 * Creates an organic wave effect by:
 * 1. Dense grid of blue dots in corner regions extending toward center
 * 2. "Active regions" that move around
 * 3. Dots in active regions flicker, others are dim
 * 4. Blue glow underlays the corner regions
 */

import { useEffect, useRef } from 'react';
import type { Dot } from './browserBorderGlow/config';
import { generateGlow } from './browserBorderGlow/glow';
import { generateDots } from './browserBorderGlow/dots';
import { renderFrame } from './browserBorderGlow/render';

interface BrowserBorderGlowProps {
  className?: string;
}

interface Dimensions {
  width: number;
  height: number;
  dpr: number;
}

export default function BrowserBorderGlow({ className }: BrowserBorderGlowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const dotsRef = useRef<Dot[]>([]);
  const glowDataRef = useRef<Uint8ClampedArray | null>(null);
  const dimensionsRef = useRef<Dimensions>({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      dimensionsRef.current = { width: rect.width, height: rect.height, dpr };

      const canvasWidth = Math.floor(rect.width * dpr);
      const canvasHeight = Math.floor(rect.height * dpr);

      dotsRef.current = generateDots(canvasWidth, canvasHeight, dpr);
      if (canvasWidth > 0 && canvasHeight > 0) {
        glowDataRef.current = generateGlow(canvasWidth, canvasHeight, dpr);
      }
    };

    const animate = (timestamp: number) => {
      const { width, height, dpr } = dimensionsRef.current;
      const canvasWidth = Math.floor(width * dpr);
      const canvasHeight = Math.floor(height * dpr);
      const glowData = glowDataRef.current;

      if (canvasWidth === 0 || canvasHeight === 0 || !glowData) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      renderFrame({
        ctx,
        canvasWidth,
        canvasHeight,
        dpr,
        glowData,
        dots: dotsRef.current,
        timestamp,
      });
      animationRef.current = requestAnimationFrame(animate);
    };

    resizeCanvas();
    animationRef.current = requestAnimationFrame(animate);

    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);

    return () => {
      cancelAnimationFrame(animationRef.current);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
}
