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
 *   A pill-shaped window over the animation. Inside the pill the SAME frame is
 *   re-rendered (chars align 1:1 with the animation beneath), rose-tinted via
 *   background-clip:text, with the frame's whitespace filled by shimmering
 *   glyphs so the pill is fully packed. A transparent button with a 1px rose
 *   border sits on top, centered on the animation (CTA_PILL.shiftY offsets).
 *   The button reveals its label on hover via a pure-CSS vertical roll: at rest
 *   an arrow glyph shows; on hover the arrow rolls up out of the capsule while
 *   the label rolls up into place (group-hover), the border warms, and a scrim
 *   fades in so the label reads over the bright glyphs. No React state — the
 *   whole reveal is CSS group-hover, so it doesn't touch the ANIMATING machine.
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
const CTA_PILL = { width: 200, height: 36, shiftY: 0, radius: 18 };

// Same glyph family the engine frames use, so the fill reads as more of the
// same animation rather than foreign characters.
const CTA_FILL_CHARS = '01i;:.tLCGf8@il1t';

// Deterministic per-cell phase so fill cells cycle out of step with each other
// (flowing shimmer, not uniform flicker). No Math.random → stable per render.
function ctaCellPhase(row: number, col: number): number {
  return (row * 92821 + col * 68917) >>> 0;
}

/**
 * The pill's content is the SAME frame as the animation beneath — real glyphs
 * keep their exact positions (no chars-on-chars) — with only the whitespace
 * replaced by fill glyphs keyed to the frame tick.
 */
function buildCtaFrame(frame: string, frameIndex: number): string {
  return frame
    .split('\n')
    .map((line, row) =>
      Array.from(line, (ch, col) =>
        ch === ' '
          ? CTA_FILL_CHARS[(ctaCellPhase(row, col) + frameIndex) % CTA_FILL_CHARS.length]
          : ch,
      ).join(''),
    )
    .join('\n');
}

// Pill window: clip-path keeps only the capsule (centered, shifted down one
// line). Longhand background props ONLY — the `background` shorthand resets
// background-clip, which would paint a solid rectangle over the glyphs. The
// gradient is sized/anchored to the pill box, so glyphs pick up the color at
// their position within the pill.
const CTA_OVERLAY_STYLE: React.CSSProperties = {
  // Saturated variants of the Rose brand stops — thin 12px glyphs wash out the
  // stock palette, so the tint runs hotter to stay vibrant at this scale.
  backgroundImage: 'linear-gradient(90deg, #FF6B00, #FF4045, #FF2D6C, #F02DD6, #A438FF, #6C47FF)',
  backgroundSize: `${CTA_PILL.width}px 100%`,
  backgroundPosition: 'center',
  backgroundRepeat: 'no-repeat',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
  textAlign: 'center',
  clipPath: `inset(calc(50% - ${CTA_PILL.height / 2 - CTA_PILL.shiftY}px) calc(50% - ${CTA_PILL.width / 2}px) calc(50% - ${CTA_PILL.height / 2 + CTA_PILL.shiftY}px) round ${CTA_PILL.radius}px)`,
};

// Gradient-colored glyph shadow: drop-shadow() only takes ONE color, so the
// shadow is a second copy of the same gradient-clipped glyph layer — offset
// down, tightly blurred, and dimmed. Each glyph's shadow therefore carries the
// gradient color at its own position. The blur stays small so it hugs glyph
// shapes instead of hazing the space between them.
const CTA_SHADOW_STYLE: React.CSSProperties = {
  ...CTA_OVERLAY_STYLE,
  transform: `translateY(2px)`,
  filter: 'blur(1.5px) brightness(0.85)',
  opacity: 0.7,
};

// Both the rest-state arrow and the revealed label are plain white glyphs — a
// solid text-shadow keeps them legible over the bright rose pill without the
// chrome gradient competing with the animation behind them.
const CTA_GLYPH_STYLE: React.CSSProperties = {
  color: '#ffffff',
  textShadow: '0 1px 5px rgba(0, 0, 0, 0.9), 0 0 1px rgba(0, 0, 0, 0.9)',
};

// Ease + timing shared by the arrow/label roll so they move as one unit.
const CTA_ROLL = 'transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]';

function AsciiCtaOverlay({
  frame,
  frameIndex,
  fontSize,
  cta,
}: {
  frame: string;
  frameIndex: number;
  fontSize: string;
  cta: AsciiLoaderCta;
}) {
  const ctaFrame = buildCtaFrame(frame, frameIndex);

  return (
    <>
      <pre
        aria-hidden
        data-testid="opening-join-prism-shadow"
        className="leading-none font-mono select-none pointer-events-none absolute inset-0"
        style={{ ...CTA_SHADOW_STYLE, fontSize }}
      >
        {ctaFrame}
      </pre>
      <pre
        aria-hidden
        data-testid="opening-join-prism"
        className="leading-none font-mono select-none pointer-events-none absolute inset-0"
        style={{ ...CTA_OVERLAY_STYLE, fontSize }}
      >
        {ctaFrame}
      </pre>
      <button
        type="button"
        onClick={cta.onClick}
        data-testid="opening-join-waitlist"
        aria-label={cta.label}
        className="group pointer-events-auto absolute left-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center overflow-hidden rounded-full border border-[#E062CC]/60 bg-transparent transition-colors duration-200 hover:border-[#FF4069]/90 focus-visible:border-[#FF4069]/90"
        style={{
          top: `calc(50% + ${CTA_PILL.shiftY}px)`,
          width: CTA_PILL.width,
          height: CTA_PILL.height,
        }}
      >
        {/* Legibility scrim — darkens the pill center on hover so the white
            label reads over the bright rose glyphs. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100"
          style={{
            background:
              'radial-gradient(ellipse 72% 92% at 50% 50%, rgba(0,0,0,0.55), rgba(0,0,0,0) 74%)',
          }}
        />
        {/* Rest state: arrow rolls up and out on hover. */}
        <span
          aria-hidden
          data-testid="opening-join-icon"
          className={`[grid-area:1/1] text-base font-semibold ${CTA_ROLL} group-hover:-translate-y-[150%] group-hover:opacity-0 group-focus-visible:-translate-y-[150%] group-focus-visible:opacity-0`}
          style={CTA_GLYPH_STYLE}
        >
          →
        </span>
        {/* Hover state: label rolls up into place. */}
        <span
          data-testid="opening-join-label"
          className={`[grid-area:1/1] translate-y-[150%] whitespace-nowrap text-sm font-bold tracking-wide opacity-0 ${CTA_ROLL} group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100`}
          style={CTA_GLYPH_STYLE}
        >
          {cta.label}
        </span>
      </button>
    </>
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
        {cta && (
          <AsciiCtaOverlay
            frame={currentFrame}
            frameIndex={frameIndex}
            fontSize={fontSize}
            cta={cta}
          />
        )}
      </div>
      {showWarmingUp && <p className="text-sm text-muted-foreground">Warming up{dots}</p>}
      {status && (
        <p className="text-xs text-muted-foreground/70 max-w-md px-4 text-center">{status}</p>
      )}
    </div>
  );
}
