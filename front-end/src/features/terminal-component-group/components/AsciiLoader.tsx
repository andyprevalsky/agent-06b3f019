/**
 * STATE MACHINE: AsciiLoader
 *
 * [ANIMATING] --> cycles through ASCII frames
 *     |
 *     +--> frameIndex: 0..N (cycles via setInterval)
 *     +--> dotCount: 1..3 (loading dots animation)
 *
 * Animation runs continuously while component is mounted.
 * Frame set determined by variant prop ('default' | 'engine').
 */

import { useEffect, useState } from 'react';
import asciiFramesData from './ascii-frames.json';
import asciiFramesEngineData from './ascii-frames-engine.json';

// Import the generated ASCII frames from video
const ASCII_FRAMES = asciiFramesData as string[];
const ASCII_FRAMES_ENGINE = asciiFramesEngineData as string[];

interface AsciiLoaderProps {
  status?: string;
  showWarmingUp?: boolean;
  size?: 'icon' | 'small' | 'normal' | 'large';
  fitContainer?: boolean;
  variant?: 'default' | 'engine';
}

export default function AsciiLoader({
  status,
  showWarmingUp = true,
  size = 'small',
  fitContainer = false,
  variant = 'default',
}: AsciiLoaderProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [dotCount, setDotCount] = useState(1);

  // Select the appropriate frame set based on variant
  const frames = variant === 'engine' ? ASCII_FRAMES_ENGINE : ASCII_FRAMES;

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, 40); // 40ms per frame = ~8-10 second loop

    return () => clearInterval(interval);
  }, [frames.length]);

  useEffect(() => {
    const dotInterval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1); // Cycle through 1, 2, 3
    }, 500); // Change dots every 500ms

    return () => clearInterval(dotInterval);
  }, []);

  const fontSize =
    size === 'icon'
      ? '0.25rem'
      : size === 'small'
        ? '0.375rem'
        : size === 'large'
          ? '0.75rem'
          : '0.5rem'; // 4px, 6px, 8px, or 12px
  const dots = '.'.repeat(dotCount);

  // If fitContainer is true, show 3 animations in a row
  if (fitContainer) {
    return (
      <div className="flex items-center gap-1">
        <pre
          className="leading-none font-mono select-none"
          style={{
            fontSize: '0.06rem',
            background: 'linear-gradient(to bottom, #4a4a48, #6b6b68, #8d8d8a, #b0b0ad, #d4d4d1)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            filter: 'drop-shadow(0 0 6px rgba(141, 141, 138, 0.4))',
            textAlign: 'center',
          }}
        >
          {frames[frameIndex]}
        </pre>
        <pre
          className="leading-none font-mono select-none"
          style={{
            fontSize: '0.06rem',
            background: 'linear-gradient(to bottom, #4a4a48, #6b6b68, #8d8d8a, #b0b0ad, #d4d4d1)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            filter: 'drop-shadow(0 0 6px rgba(141, 141, 138, 0.4))',
            textAlign: 'center',
          }}
        >
          {frames[frameIndex]}
        </pre>
        <pre
          className="leading-none font-mono select-none"
          style={{
            fontSize: '0.06rem',
            background: 'linear-gradient(to bottom, #4a4a48, #6b6b68, #8d8d8a, #b0b0ad, #d4d4d1)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            filter: 'drop-shadow(0 0 6px rgba(141, 141, 138, 0.4))',
            textAlign: 'center',
          }}
        >
          {frames[frameIndex]}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-4">
      {/* ASCII Art Animation */}
      <pre
        className="leading-none font-mono select-none"
        style={{
          fontSize,
          background: 'linear-gradient(to bottom, #4a4a48, #6b6b68, #8d8d8a, #b0b0ad, #d4d4d1)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          filter: 'drop-shadow(0 0 6px rgba(141, 141, 138, 0.4))',
          textAlign: 'center',
        }}
      >
        {frames[frameIndex]}
      </pre>

      {/* Warming up text */}
      {showWarmingUp && <p className="text-sm text-muted-foreground">Warming up{dots}</p>}

      {/* Status Message */}
      {status && (
        <p className="text-xs text-muted-foreground/70 max-w-md px-4 text-center">{status}</p>
      )}
    </div>
  );
}
