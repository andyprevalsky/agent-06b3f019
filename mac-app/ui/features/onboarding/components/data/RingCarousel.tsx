/**
 * STATE MACHINE: RingCarousel
 *
 * [AT_REST(activeIndex)] --activeIndex prop change--> [ROTATING] --0.7s--> [AT_REST]
 * [AT_REST] --celebrate rising edge--> [SPINNING(3s, 4 turns)] --snap--> [AT_REST]
 *
 * System context:
 *   OnboardingData -> RingCarousel: 3D ring of category icons viewed from the
 *   front with a slight downward tilt. Icons sit centered ON a visible ring;
 *   connected categories light their arc segment (fixed rose color, blended
 *   edges) and tint their glyph with the rose gradient.
 */

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import {
  GAP_BELOW_RING,
  RING_ITEM_SIZE,
  RING_SCENE_HEIGHT,
  RING_SCENE_WIDTH,
  RING_RADIUS,
  RING_TILT_DEG,
  RING_TRANSITION,
  SPIN_DURATION_MS,
  SPIN_TURNS,
  easeInOutCubic,
  itemAngle,
  itemStyle,
  segmentGeometry,
  shortestDelta,
} from './ringGeometry';
import { RoseGlyphDefs } from './ringGlyphs';
import './onboarding-ring.css';

export interface RingCategoryView {
  id: string;
  name: string;
  glyph: ReactNode;
  connected: boolean;
}

interface RingCarouselProps {
  categories: RingCategoryView[];
  activeIndex: number;
  onSelect: (index: number) => void;
  celebrate: boolean;
}

/** Rotation state: follows activeIndex via the shortest path around the ring. */
function useRingRotation(activeIndex: number, count: number): number {
  const [rotation, setRotation] = useState(0);
  const prevIndexRef = useRef(activeIndex);
  useEffect(() => {
    const delta = shortestDelta(prevIndexRef.current, activeIndex, count);
    prevIndexRef.current = activeIndex;
    if (delta !== 0) setRotation((r) => r - delta * (360 / count));
  }, [activeIndex, count]);
  return rotation;
}

/**
 * Celebration spin: on the rising edge of `celebrate`, drive 4 full turns over
 * 3s per-frame with transitions off (depth scale/opacity/z stay correct), then
 * snap back to the resting angle and re-enable transitions a frame later —
 * restoring in the same tick would animate the reset as a reverse spin.
 */
function useCelebrationSpin(
  celebrate: boolean,
  setRotation: (updater: (r: number) => number) => void
): boolean {
  const [spinning, setSpinning] = useState(false);
  const wasCelebratingRef = useRef(celebrate);
  const rafRef = useRef(0);

  useEffect(() => {
    const rising = celebrate && !wasCelebratingRef.current;
    wasCelebratingRef.current = celebrate;
    if (!rising) return;

    setSpinning(true);
    const start = performance.now();
    let lastApplied = 0;
    const frame = (now: number): void => {
      const t = Math.min(1, (now - start) / SPIN_DURATION_MS);
      const target = -SPIN_TURNS * 360 * easeInOutCubic(t);
      setRotation((r) => r + (target - lastApplied));
      lastApplied = target;
      if (t < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        setRotation((r) => r - lastApplied); // 4 whole turns -> identical pose
        rafRef.current = requestAnimationFrame(() => setSpinning(false));
      }
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [celebrate, setRotation]);

  return spinning;
}

/**
 * The 3D projection paints inside the scene's layout box (constant overhangs
 * static margins can't know). Collapse the box to its RENDERED bounds so the
 * surrounding flex layout and the gap to the category label are exact.
 */
function useRingSpacing(sceneRef: React.RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const settle = (): void => {
      const scene = sceneRef.current;
      if (scene === null) return;
      const rects = [
        ...Array.from(scene.querySelectorAll('.onb-ring-frame')),
        ...Array.from(scene.querySelectorAll('.onb-ring-circle')),
      ].map((el) => el.getBoundingClientRect());
      if (rects.length === 0) return;
      const sceneRect = scene.getBoundingClientRect();
      const visTop = Math.min(...rects.map((r) => r.top));
      const visBottom = Math.max(...rects.map((r) => r.bottom));
      scene.style.marginTop = `${sceneRect.top - visTop}px`;
      scene.style.marginBottom = `${GAP_BELOW_RING - (sceneRect.bottom - visBottom)}px`;
    };
    settle();
    window.addEventListener('resize', settle);
    return () => window.removeEventListener('resize', settle);
  }, [sceneRef]);
}

function RingSvgDefs({
  categories,
  segments,
}: {
  categories: RingCategoryView[];
  segments: ReturnType<typeof segmentGeometry>;
}): JSX.Element {
  return (
    <defs>
      <filter id="onbSegBlur" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="5" />
      </filter>
      <linearGradient id="onbShimmerG" x1="100%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#FE7503" />
        <stop offset="50%" stopColor="#E062CC" />
        <stop offset="100%" stopColor="#7A6BEC" />
      </linearGradient>
      {segments.map((seg, i) => (
        <linearGradient
          key={categories[i].id}
          id={`onbSegG${i}`}
          gradientUnits="userSpaceOnUse"
          x1={seg.gradient.x1}
          y1={seg.gradient.y1}
          x2={seg.gradient.x2}
          y2={seg.gradient.y2}
        >
          <stop offset="0%" stopColor={seg.gradient.stops[0]} />
          <stop offset="50%" stopColor={seg.gradient.stops[1]} />
          <stop offset="100%" stopColor={seg.gradient.stops[2]} />
        </linearGradient>
      ))}
    </defs>
  );
}

function RingSvg({
  categories,
  rotation,
  spinning,
}: {
  categories: RingCategoryView[];
  rotation: number;
  spinning: boolean;
}): JSX.Element {
  const segments = segmentGeometry(categories.length);
  const d = RING_RADIUS * 2;
  const circumference = 2 * Math.PI * RING_RADIUS;
  return (
    <svg
      className={`onb-ring-svg${spinning ? ' onb-no-anim' : ''}`}
      viewBox={`0 0 ${d} ${d}`}
      style={{ transform: `rotate(${-rotation}deg)` }}
      aria-hidden="true"
    >
      <RingSvgDefs categories={categories} segments={segments} />
      <circle
        cx={RING_RADIUS}
        cy={RING_RADIUS}
        r={RING_RADIUS}
        fill="none"
        stroke="hsl(var(--border))"
        strokeWidth="1.5"
      />
      <g fill="none" strokeLinecap="round" strokeWidth="9" filter="url(#onbSegBlur)">
        {segments.map((seg, i) => (
          <path
            key={categories[i].id}
            d={seg.pathD}
            stroke={`url(#onbSegG${i})`}
            opacity={categories[i].connected ? 1 : 0}
          />
        ))}
      </g>
      <g fill="none" strokeLinecap="round" strokeWidth="2.5">
        {segments.map((seg, i) => (
          <path
            key={categories[i].id}
            d={seg.pathD}
            stroke={`url(#onbSegG${i})`}
            opacity={categories[i].connected ? 1 : 0}
          />
        ))}
      </g>
      <circle
        id="onb-ring-shimmer"
        cx={RING_RADIUS}
        cy={RING_RADIUS}
        r={RING_RADIUS}
        fill="none"
        stroke="url(#onbShimmerG)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`110 ${(circumference - 110).toFixed(0)}`}
      />
    </svg>
  );
}

export default function RingCarousel({
  categories,
  activeIndex,
  onSelect,
  celebrate,
}: RingCarouselProps): JSX.Element {
  const count = categories.length;
  const [spinOffset, setSpinOffset] = useState(0);
  const baseRotation = useRingRotation(activeIndex, count);
  const spinning = useCelebrationSpin(celebrate, setSpinOffset);
  const rotation = baseRotation + spinOffset;
  const sceneRef = useRef<HTMLDivElement | null>(null);
  useRingSpacing(sceneRef);

  return (
    <div
      ref={sceneRef}
      className="onb-scene relative"
      style={{ width: RING_SCENE_WIDTH, height: RING_SCENE_HEIGHT }}
    >
      <RoseGlyphDefs />
      <div className="onb-ring-layer" style={{ transform: `rotateX(${-RING_TILT_DEG}deg)` }}>
        <div
          className="onb-ring-circle"
          style={{ width: RING_RADIUS * 2, height: RING_RADIUS * 2 }}
        >
          <RingSvg categories={categories} rotation={rotation} spinning={spinning} />
        </div>
      </div>
      <div
        className="onb-items-layer"
        style={{ transform: `rotateX(${-RING_TILT_DEG}deg)` }}
        aria-hidden={false}
      >
        {categories.map((cat, i) => {
          const style = itemStyle(itemAngle(i, count, rotation));
          return (
            <button
              key={cat.id}
              type="button"
              aria-label={cat.name}
              onClick={() => onSelect(i)}
              className={`onb-ring-item${spinning ? ' onb-no-anim' : ''}`}
              style={{
                width: RING_ITEM_SIZE,
                height: RING_ITEM_SIZE,
                margin: `-${RING_ITEM_SIZE / 2}px 0 0 -${RING_ITEM_SIZE / 2}px`,
                transform: style.transform,
                opacity: style.opacity,
                zIndex: style.zIndex,
                filter: style.desaturated ? 'saturate(0.7)' : 'none',
                transition: spinning ? 'none' : RING_TRANSITION,
              }}
            >
              <span className="onb-ring-frame" data-synced={String(cat.connected)}>
                <span className="onb-glow" aria-hidden="true" />
                <span className="onb-frame-inner">{cat.glyph}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
