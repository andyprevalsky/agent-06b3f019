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

interface BrowserBorderGlowProps {
  className?: string;
}

// Grid and animation configuration
const CONFIG = {
  gridSpacing: 4,
  dotRadius: 1,
  // How far corners extend toward center
  cornerRadius: 525,
  // Persistent glow underneath
  glowOpacity: 0.45,
  glowColor: { r: 186, g: 230, b: 253 }, // sky-200 (light, close to white)
  numWaves: 3,
  waveWidth: 0.22,
  waveSpeed: 0.00003125, // 4x slower
  flickerSpeed: 0.004,
  minOpacity: 0.02,
  maxOpacity: 0.5,
  // Light color for dots (close to white with hint of blue)
  dotColor: { r: 224, g: 242, b: 254 }, // sky-100
};

interface Dot {
  x: number;
  y: number;
  // Which corner (0-3) and normalized distance from it
  cornerIndex: number;
  cornerDist: number; // 0 = at corner, 1 = at edge of corner region
  flickerPhase: number;
}

export default function BrowserBorderGlow({ className }: BrowserBorderGlowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const dotsRef = useRef<Dot[]>([]);
  const glowDataRef = useRef<Uint8ClampedArray | null>(null);
  const dimensionsRef = useRef({ width: 0, height: 0, dpr: 1 });

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

      generateDots(canvasWidth, canvasHeight, dpr);
      generateGlow(canvasWidth, canvasHeight, dpr);
    };

    const generateGlow = (width: number, height: number, dpr: number) => {
      if (width === 0 || height === 0) return;

      const { glowOpacity, cornerRadius, glowColor } = CONFIG;
      const scaledRadius = cornerRadius * dpr;
      const glowData = new Uint8ClampedArray(width * height * 4);

      const corners = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ];

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let glowIntensity = 0;
          for (const corner of corners) {
            const dist = Math.sqrt((x - corner.x) ** 2 + (y - corner.y) ** 2);
            const intensity = Math.max(0, 1 - dist / scaledRadius);
            // Use squared falloff for softer edges
            glowIntensity = Math.max(glowIntensity, intensity * intensity);
          }
          if (glowIntensity > 0) {
            const idx = (y * width + x) * 4;
            glowData[idx] = glowColor.r;
            glowData[idx + 1] = glowColor.g;
            glowData[idx + 2] = glowColor.b;
            glowData[idx + 3] = glowIntensity * glowOpacity * 255;
          }
        }
      }

      glowDataRef.current = glowData;
    };

    const generateDots = (width: number, height: number, dpr: number) => {
      const dots: Dot[] = [];
      const { gridSpacing, cornerRadius } = CONFIG;
      const scaledSpacing = Math.max(2, gridSpacing * dpr);
      const scaledRadius = cornerRadius * dpr;

      const corners = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ];

      for (let x = 0; x < width; x += scaledSpacing) {
        for (let y = 0; y < height; y += scaledSpacing) {
          // Find closest corner and distance
          let minDist = Infinity;
          let closestCorner = 0;

          for (let i = 0; i < corners.length; i++) {
            const corner = corners[i];
            const dist = Math.sqrt((x - corner.x) ** 2 + (y - corner.y) ** 2);
            if (dist < minDist) {
              minDist = dist;
              closestCorner = i;
            }
          }

          // Only add dots within corner radius
          if (minDist < scaledRadius) {
            const normalizedDist = minDist / scaledRadius;
            dots.push({
              x: Math.floor(x),
              y: Math.floor(y),
              cornerIndex: closestCorner,
              cornerDist: normalizedDist,
              flickerPhase: Math.random() * Math.PI * 2,
            });
          }
        }
      }

      dotsRef.current = dots;
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

      // Copy cached glow data
      const imageData = ctx.createImageData(canvasWidth, canvasHeight);
      imageData.data.set(glowData);
      const data = imageData.data;

      const { numWaves, waveWidth, waveSpeed, flickerSpeed, minOpacity, maxOpacity, dotRadius, dotColor } = CONFIG;
      const scaledRadius = Math.max(1, Math.floor(dotRadius * dpr));

      // Calculate wave positions - each wave rotates around corners
      const wavePositions: number[] = [];
      for (let i = 0; i < numWaves; i++) {
        // Waves cycle through corners (0, 1, 2, 3, 0, ...)
        const pos = ((timestamp * waveSpeed * 4) + (i / numWaves)) % 1;
        wavePositions.push(pos);
      }

      // Draw dots
      for (const dot of dotsRef.current) {
        // Calculate which wave is closest to this dot's corner
        // Each corner gets a position: 0, 0.25, 0.5, 0.75
        const cornerPos = dot.cornerIndex / 4;

        let minWaveDist = 1;
        for (const wavePos of wavePositions) {
          let dist = Math.abs(cornerPos - wavePos);
          if (dist > 0.5) dist = 1 - dist;
          minWaveDist = Math.min(minWaveDist, dist);
        }

        const waveInfluence = Math.max(0, 1 - minWaveDist / waveWidth);
        const flicker = waveInfluence > 0.05
          ? 0.5 + 0.5 * Math.sin(timestamp * flickerSpeed + dot.flickerPhase)
          : 0;

        // Fade out towards edge of corner region
        const edgeFade = 1 - dot.cornerDist;
        const baseOpacity = minOpacity * edgeFade * edgeFade;
        const activeOpacity = waveInfluence * flicker * (maxOpacity - minOpacity) * edgeFade;
        const opacity = baseOpacity + activeOpacity;

        if (opacity > 0.01) {
          const alpha = Math.min(255, opacity * 255);
          // Draw dot pixels (blue color)
          for (let dy = -scaledRadius; dy <= scaledRadius; dy++) {
            for (let dx = -scaledRadius; dx <= scaledRadius; dx++) {
              const px = dot.x + dx;
              const py = dot.y + dy;
              if (px >= 0 && px < canvasWidth && py >= 0 && py < canvasHeight) {
                const idx = (py * canvasWidth + px) * 4;
                const existingAlpha = data[idx + 3] / 255;
                const newAlpha = alpha / 255;
                const outAlpha = newAlpha + existingAlpha * (1 - newAlpha);
                if (outAlpha > 0) {
                  // Blend blue dots over blue glow
                  data[idx] = (dotColor.r * newAlpha + data[idx] * existingAlpha * (1 - newAlpha)) / outAlpha;
                  data[idx + 1] = (dotColor.g * newAlpha + data[idx + 1] * existingAlpha * (1 - newAlpha)) / outAlpha;
                  data[idx + 2] = (dotColor.b * newAlpha + data[idx + 2] * existingAlpha * (1 - newAlpha)) / outAlpha;
                  data[idx + 3] = outAlpha * 255;
                }
              }
            }
          }
        }
      }

      ctx.putImageData(imageData, 0, 0);
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
