import { useEffect, useState } from 'react';
import asciiFramesData from './ascii-frames.json';

// Import the generated ASCII frames from video
const ASCII_FRAMES = asciiFramesData as string[];

interface AsciiLoaderProps {
  status?: string;
  showWarmingUp?: boolean;
  size?: 'small' | 'normal';
}

export default function AsciiLoader({ status, showWarmingUp = true, size = 'small' }: AsciiLoaderProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % ASCII_FRAMES.length);
    }, 40); // 40ms per frame = 10 second loop for 250 frames

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const dotInterval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1); // Cycle through 1, 2, 3
    }, 500); // Change dots every 500ms

    return () => clearInterval(dotInterval);
  }, []);

  const fontSize = size === 'small' ? '0.375rem' : '0.5rem'; // 6px or 8px
  const dots = '.'.repeat(dotCount);

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
        }}
      >
        {ASCII_FRAMES[frameIndex]}
      </pre>

      {/* Warming up text */}
      {showWarmingUp && (
        <p className="text-sm text-muted-foreground">
          Warming up{dots}
        </p>
      )}

      {/* Status Message */}
      {status && (
        <p className="text-xs text-muted-foreground/70 max-w-md px-4 text-center">
          {status}
        </p>
      )}
    </div>
  );
}


