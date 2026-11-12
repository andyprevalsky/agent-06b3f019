/**
 * STATE MACHINE: AsciiLoader
 *
 * [ANIMATING] --> cycles through ASCII frames every 40ms
 *     |
 *     +--> frameIndex: 0..N (setInterval writes each frame straight into the
 *     |    <pre> layers' text — no React render per frame)
 *     +--> dotCount: 1..3 (loading dots animation, only while shown)
 *     |
 *     v  page hidden OR loader out of view (IntersectionObserver)
 *        OR app covered by an opaque full-screen overlay (lib/appCover)
 * [HELD] --> interval stopped on the current frame; resumes from it when the
 *            page is visible and the loader is in view again
 *
 * Frame set determined by variant prop ('default' | 'engine').
 * The frame layers carry data-amp-block: session replay records a placeholder
 * instead of 25 full-frame text mutations per second (no visual effect).
 *
 * CTA OVERLAY (optional `cta` prop):
 *   A pill-shaped window over the animation. Inside the pill the SAME frame is
 *   re-rendered (chars align 1:1 with the animation beneath), rose-tinted via
 *   background-clip:text, with the frame's whitespace filled by shimmering
 *   glyphs so the pill is fully packed. A transparent button with a 1px rose
 *   border sits on top, centered on the animation (CTA_PILL.shiftY offsets).
 *   The button label stays visible across mouse, keyboard, and touch input; a
 *   text shadow keeps it legible without darkening the whole pill while the
 *   border warms on hover/focus. The CTA has no React state, so it does not touch the
 *   ANIMATING machine.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isAppCovered, subscribeAppCover } from '@/lib/appCover';
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

const FRAME_INTERVAL_MS = 40;

/** A <pre> whose text the frame ticker writes: 'frame' shows the frame as-is,
 * 'cta' shows it with whitespace filled (CTA pill layers). */
type AsciiLayer = 'frame' | 'cta';

function AsciiPre({ fontSize }: { fontSize: string }) {
  return (
    <pre
      data-ascii-layer="frame"
      data-amp-block=""
      className="leading-none font-mono select-none"
      style={{ ...BASE_PRE_STYLE, fontSize }}
    />
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

const ctaFrameCache = new WeakMap<readonly string[], Map<number, string>>();

/** buildCtaFrame is pure per (frame set, index): build each pill frame once. */
function ctaFrameFor(frames: readonly string[], frameIndex: number): string {
  let cache = ctaFrameCache.get(frames);
  if (cache === undefined) {
    cache = new Map();
    ctaFrameCache.set(frames, cache);
  }
  let frame = cache.get(frameIndex);
  if (frame === undefined) {
    frame = buildCtaFrame(frames[frameIndex], frameIndex);
    cache.set(frameIndex, frame);
  }
  return frame;
}

function setLayerText(pre: HTMLPreElement, text: string): void {
  const node = pre.firstChild;
  if (node instanceof Text && node === pre.lastChild) node.data = text;
  else pre.textContent = text;
}

/** Writes frame `frameIndex` into every ASCII layer under `container`. */
function paintFrame(container: HTMLElement, frames: readonly string[], frameIndex: number): void {
  for (const pre of container.querySelectorAll<HTMLPreElement>('pre[data-ascii-layer]')) {
    const layer = pre.dataset.asciiLayer as AsciiLayer;
    setLayerText(pre, layer === 'cta' ? ctaFrameFor(frames, frameIndex) : frames[frameIndex]);
  }
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

// The always-visible label is plain white; a solid text-shadow keeps it legible
// over the bright rose pill without competing with the animation behind it.
const CTA_GLYPH_STYLE: React.CSSProperties = {
  color: '#ffffff',
  textShadow: '0 1px 5px rgba(0, 0, 0, 0.9), 0 0 1px rgba(0, 0, 0, 0.9)',
};

function AsciiCtaOverlay({ fontSize, cta }: { fontSize: string; cta: AsciiLoaderCta }) {
  return (
    <>
      <pre
        aria-hidden
        data-testid="opening-join-prism-shadow"
        data-ascii-layer="cta"
        data-amp-block=""
        className="leading-none font-mono select-none pointer-events-none absolute inset-0"
        style={{ ...CTA_SHADOW_STYLE, fontSize }}
      />
      <pre
        aria-hidden
        data-testid="opening-join-prism"
        data-ascii-layer="cta"
        data-amp-block=""
        className="leading-none font-mono select-none pointer-events-none absolute inset-0"
        style={{ ...CTA_OVERLAY_STYLE, fontSize }}
      />
      <button
        type="button"
        onClick={cta.onClick}
        data-testid="opening-join-waitlist"
        aria-label={cta.label}
        className="pointer-events-auto absolute left-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center rounded-full border border-[#E062CC]/60 bg-transparent transition-colors duration-200 hover:border-[#FF4069]/90 focus-visible:border-[#FF4069]/90"
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
    </>
  );
}

/**
 * Cycles `frames` through the layers under `containerRef` every 40ms while the
 * page is visible and the loader is in view. `layersKey` changes whenever the
 * set of layers does, so new layers get the current frame before paint.
 */
function useAsciiFrames(
  containerRef: RefObject<HTMLElement>,
  frames: readonly string[],
  layersKey: string,
): void {
  const frameIndexRef = useRef(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    frameIndexRef.current %= frames.length;
    paintFrame(container, frames, frameIndexRef.current);
  }, [containerRef, frames, layersKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    let inView = true;

    const sync = () => {
      const run = inView && !document.hidden && !isAppCovered();
      if (run && interval === null) {
        interval = setInterval(() => {
          frameIndexRef.current = (frameIndexRef.current + 1) % frames.length;
          paintFrame(container, frames, frameIndexRef.current);
        }, FRAME_INTERVAL_MS);
      } else if (!run && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            inView = entries.some((entry) => entry.isIntersecting);
            sync();
          });
    observer?.observe(container);
    document.addEventListener('visibilitychange', sync);
    const unsubscribeCover = subscribeAppCover(sync);
    sync();

    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      unsubscribeCover();
      if (interval !== null) clearInterval(interval);
    };
  }, [containerRef, frames, layersKey]);
}

function useAnimatedDots(enabled: boolean): number {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (!enabled) return;
    const dotInterval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(dotInterval);
  }, [enabled]);

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
  const layersRef = useRef<HTMLDivElement>(null);
  useAsciiFrames(layersRef, frames, `${fitContainer}:${cta !== undefined}`);
  const dotCount = useAnimatedDots(showWarmingUp && !fitContainer);
  const fontSize = getFontSize(size);
  const dots = '.'.repeat(dotCount);

  if (fitContainer) {
    return (
      <div ref={layersRef} className="flex items-center gap-1">
        <AsciiPre fontSize="0.06rem" />
        <AsciiPre fontSize="0.06rem" />
        <AsciiPre fontSize="0.06rem" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-4">
      <div ref={layersRef} className="relative">
        <AsciiPre fontSize={fontSize} />
        {cta && <AsciiCtaOverlay fontSize={fontSize} cta={cta} />}
      </div>
      {showWarmingUp && <p className="text-sm text-muted-foreground">Warming up{dots}</p>}
      {status && (
        <p className="text-xs text-muted-foreground/70 max-w-md px-4 text-center">{status}</p>
      )}
    </div>
  );
}
