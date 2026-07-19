/**
 * STATE MACHINE: ringGeometry (pure math — no state)
 *
 * [ANGLES] --itemAngle/shortestDelta--> ring positions
 * [SEGMENTS] --segmentGeometry--> per-category arc paths + blended gradients
 *
 * System context:
 *   OnboardingData -> RingCarousel -> ringGeometry
 *   All 3D-ring constants and projection math for the "Connect your Data"
 *   onboarding step live here so the carousel component stays presentational.
 */

export const RING_RADIUS = 200;
export const RING_ITEM_SIZE = 60;
export const RING_TILT_DEG = 16;
export const RING_SCENE_WIDTH = 560;
export const RING_SCENE_HEIGHT = 210;
export const RING_FRONT_SCALE = 1;
export const RING_BACK_SCALE = 0.55;
export const RING_BACK_OPACITY = 0.35;
/** Gap between the ring's lowest rendered point (front icon) and the label. */
export const GAP_BELOW_RING = 18;
export const SPIN_TURNS = 4;
export const SPIN_DURATION_MS = 3000;
export const RING_TRANSITION =
  'transform 0.7s cubic-bezier(0.33, 1, 0.68, 1), opacity 0.7s ease, filter 0.7s ease';

/** ROSE_GRADIENT stops (ui/features/onboarding/config.ts) as segment colors. */
export const ROSE_STOPS = ['#FE7503', '#FC585C', '#FD5776', '#E062CC', '#A76CED', '#7A6BEC'];

export interface RingItemStyle {
  transform: string;
  opacity: number;
  zIndex: number;
  desaturated: boolean;
}

/** Angle (deg) of item `index` given the current ring rotation. 0 = front. */
export function itemAngle(index: number, count: number, rotation: number): number {
  return index * (360 / count) + rotation;
}

/** Billboard transform + depth styling for an item at `angleDeg` on the ring. */
export function itemStyle(angleDeg: number): RingItemStyle {
  const rad = (angleDeg * Math.PI) / 180;
  const depth = (Math.cos(rad) + 1) / 2; // 1 = front, 0 = back
  const scale = RING_BACK_SCALE + (RING_FRONT_SCALE - RING_BACK_SCALE) * depth;
  return {
    // rotate into place on the ring, push out, face the camera, then
    // counter-tilt so the icon stands upright (not tilted with the ring)
    transform:
      `rotateY(${angleDeg}deg) translateZ(${RING_RADIUS}px) ` +
      `rotateY(${-angleDeg}deg) rotateX(${RING_TILT_DEG}deg) scale(${scale})`,
    opacity: RING_BACK_OPACITY + (1 - RING_BACK_OPACITY) * depth,
    zIndex: 100 + Math.round(depth * 100),
    desaturated: depth < 0.6,
  };
}

/** Shortest signed step count from `from` to `to` around a ring of `count`. */
export function shortestDelta(from: number, to: number, count: number): number {
  let delta = to - from;
  if (delta > count / 2) delta -= count;
  if (delta < -count / 2) delta += count;
  return delta;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Point on the ring circle (SVG coords, y-down; 0deg = front/bottom). */
function ringPoint(deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [RING_RADIUS + RING_RADIUS * Math.sin(rad), RING_RADIUS + RING_RADIUS * Math.cos(rad)];
}

/** 50/50 hex blend for smooth color hand-off between neighboring segments. */
export function mixHex(a: string, b: string): string {
  const parse = (hex: string): number[] =>
    (hex.slice(1).match(/../g) ?? []).map((h) => parseInt(h, 16));
  const pa = parse(a);
  const pb = parse(b);
  const mixed = pa.map((v, k) =>
    Math.round((v + pb[k]) / 2)
      .toString(16)
      .padStart(2, '0')
  );
  return `#${mixed.join('')}`;
}

export interface RingSegment {
  pathD: string;
  gradient: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** [edge blend with previous, own color, edge blend with next] */
    stops: [string, string, string];
  };
}

/**
 * Arc segments, one per category, spanning midpoint-to-midpoint around each
 * icon. Each gets a gradient along its chord: neighbor-blend at the edges and
 * its own fixed color in the middle, so a fully lit ring reads as one
 * continuous gradient.
 */
export function segmentGeometry(count: number): RingSegment[] {
  const step = 360 / count;
  const half = step / 2;
  return Array.from({ length: count }, (_, i) => {
    const cPrev = ROSE_STOPS[((i + count - 1) % count) % ROSE_STOPS.length];
    const cSelf = ROSE_STOPS[i % ROSE_STOPS.length];
    const cNext = ROSE_STOPS[((i + 1) % count) % ROSE_STOPS.length];
    const [x1, y1] = ringPoint(i * step - half);
    const [x2, y2] = ringPoint(i * step + half);
    return {
      pathD:
        `M ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
        `A ${RING_RADIUS} ${RING_RADIUS} 0 0 0 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      gradient: {
        x1,
        y1,
        x2,
        y2,
        stops: [mixHex(cPrev, cSelf), cSelf, mixHex(cSelf, cNext)],
      },
    };
  });
}
