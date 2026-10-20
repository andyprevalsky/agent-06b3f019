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
 *
 * CTA OVERLAY (optional `cta` prop):
 *   A solid white pill button (same white surface + light gray border as the
 *   left sidebar) centered on the animation (CTA_PILL.shiftY offsets), with a
 *   dark, always-visible label across mouse, keyboard, and touch input. The CTA
 *   has no React state, so it does not touch the ANIMATING machine.
 */

import { useEffect, useState } from 'react';
import asciiFramesData from './ascii-frames.json';
import asciiFramesEngineData from './ascii-frames-engine.json';

const ASCII_FRAMES = asciiFramesData as string[];
const ASCII_FRAMES_ENGINE = asciiFramesEngineData as string[];

interface AsciiLoaderCta {
  label: string;
  onClick: () => void;
}

interface AsciiLoaderProps {
  status?: string;
  showWarmingUp?: boolean;
  size?: 'icon' | 'small' | 'normal' | 'large';
  fitContainer?: boolean;
  variant?: 'default' | 'engine';
  /** Pill CTA overlaid on the animation (see CTA OVERLAY above). */
  cta?: AsciiLoaderCta;
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

// ── CTA pill overlay ──────────────────────────────────────────────────────────
// Geometry in px at the 'large' font size (0.75rem, leading-none → 12px/line).
// shiftY = vertical offset from the animation's center (one line = 12px).
const CTA_PILL = { width: 200, height: 36, shiftY: 0 };

// Dark label on the white pill; no text shadow is needed for contrast.
const CTA_GLYPH_STYLE: React.CSSProperties = {
  color: 'hsl(240 15% 8%)',
};

// Solid white pill matching the left sidebar surface (white + gray-200/60 border).
function AsciiCtaOverlay({ cta }: { cta: AsciiLoaderCta }) {
  return (
    <button
      type="button"
      onClick={cta.onClick}
      data-testid="opening-join-waitlist"
      aria-label={cta.label}
      className="pointer-events-auto absolute left-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center rounded-full border border-gray-200/60 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_4px_12px_rgba(0,0,0,0.06)] transition-colors duration-200 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none"
      style={{
        top: `calc(50% + ${CTA_PILL.shiftY}px)`,
        width: CTA_PILL.width,
        height: CTA_PILL.height,
      }}
    >
      <span
        data-testid="opening-join-label"
        className="[grid-area:1/1] whitespace-nowrap text-sm font-bold tracking-wide"
        style={CTA_GLYPH_STYLE}
      >
        {cta.label}
      </span>
    </button>
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
  cta,
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
      <div className="relative">
        <AsciiPre frame={currentFrame} fontSize={fontSize} />
        {cta && <AsciiCtaOverlay cta={cta} />}
      </div>
      {showWarmingUp && <p className="text-sm text-muted-foreground">Warming up{dots}</p>}
      {status && (
        <p className="text-xs text-muted-foreground/70 max-w-md px-4 text-center">{status}</p>
      )}
    </div>
  );
}
