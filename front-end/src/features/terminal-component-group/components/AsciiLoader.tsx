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

const ASCII_FRAMES = asciiFramesData as string[];
const ASCII_FRAMES_ENGINE = asciiFramesEngineData as string[];

interface AsciiLoaderProps {
  status?: string;
  showWarmingUp?: boolean;
  size?: 'icon' | 'small' | 'normal' | 'large';
  fitContainer?: boolean;
  variant?: 'default' | 'engine';
}

const BASE_PRE_STYLE: React.CSSProperties = {
  background: 'linear-gradient(to bottom, #4a4a48, #6b6b68, #8d8d8a, #b0b0ad, #d4d4d1)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
  filter: 'drop-shadow(0 0 6px rgba(141, 141, 138, 0.4))',
  textAlign: 'center',
};

function getFontSize(size: NonNullable<AsciiLoaderProps['size']>): string {
  if (size === 'icon') return '0.25rem';
  if (size === 'small') return '0.375rem';
  if (size === 'large') return '0.75rem';
  return '0.5rem';
}

function AsciiPre({ frame, fontSize }: { frame: string; fontSize: string }) {
  return (
    <pre className="leading-none font-mono select-none" style={{ ...BASE_PRE_STYLE, fontSize }}>
      {frame}
    </pre>
  );
}

function useAnimatedFrame(totalFrames: number): number {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % totalFrames);
    }, 40);
    return () => clearInterval(interval);
  }, [totalFrames]);

  return frameIndex;
}

function useAnimatedDots(): number {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const dotInterval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(dotInterval);
  }, []);

  return dotCount;
}

export default function AsciiLoader({
  status,
  showWarmingUp = true,
  size = 'small',
  fitContainer = false,
  variant = 'default',
}: AsciiLoaderProps) {
  const frames = variant === 'engine' ? ASCII_FRAMES_ENGINE : ASCII_FRAMES;
  const frameIndex = useAnimatedFrame(frames.length);
  const dotCount = useAnimatedDots();
  const fontSize = getFontSize(size);
  const dots = '.'.repeat(dotCount);
  const currentFrame = frames[frameIndex];

  if (fitContainer) {
    return (
      <div className="flex items-center gap-1">
        <AsciiPre frame={currentFrame} fontSize="0.06rem" />
        <AsciiPre frame={currentFrame} fontSize="0.06rem" />
        <AsciiPre frame={currentFrame} fontSize="0.06rem" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-4">
      <AsciiPre frame={currentFrame} fontSize={fontSize} />
      {showWarmingUp && <p className="text-sm text-muted-foreground">Warming up{dots}</p>}
      {status && (
        <p className="text-xs text-muted-foreground/70 max-w-md px-4 text-center">{status}</p>
      )}
    </div>
  );
}
