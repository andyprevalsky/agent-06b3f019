/**
 * STATE MACHINE: GridEnergyPills
 *
 * GEOMETRY:
 * [MEASURE_VIEWPORT] --> derives visible grid-line coordinates from patternOffset
 *   |                    (mobile: also re-measures on window resize)
 *   v
 * [SELECT_FLOW_BUDGET] --> keeps the full desktop layer and a reduced mobile layer
 *   |
 *   v
 * [RENDER_ACTIVE_THEME_FLOWS] --> desktop: one SVG tree with theme-aware gradients
 *                                 mobile: 8 absolutely positioned gradient pills
 *                                 inside an even-odd clip-path container
 *
 * THEME:
 * [STOCK]  --> opacity prop absent: no group opacity / pill opacity (unchanged)
 * [DIMMED] --> opacity prop set (Rose dark mode): SVG group opacity attribute,
 *              per-pill CSS opacity for the mobile renderer
 * A theme switch repaints in the same commit: the SVG attribute and the mobile
 * pill opacity update with the render, and both gradients read their stops from
 * CSS variables keyed on html.dark, so no animation tick is involved.
 *
 * MOTION:
 * [FLOWING] --> SVG animateTransform moves each pill along a grid line
 *   |
 *   v (mobile viewport)
 * [LEAN_FLOWING] --> up to 8 flows, no blur filter; each pill is a CSS keyframe
 *                    translate3d animation (compositor-driven, no per-frame JS)
 *                    whose start time is pinned to the document timeline origin
 *   |
 *   v (per pill, from the even-odd mask geometry)
 * [CLIPPED]  --> a flow whose track never shows through the mask at this
 *                viewport is not mounted at all
 * [PARKED]   --> while a pill is fully masked it holds still (step keyframe)
 *                and jumps to where it re-enters; on-screen it follows the
 *                exact same linear path. Masked motion still damaged the frame
 *                and forced the chat backdrop blur to re-render every frame.
 *   |
 *   v (prefers-reduced-motion: reduce)
 * [HIDDEN] --> desktop: CSS hides animated pills
 *              mobile: unchanged, keeps flowing (as the former canvas did)
 * Mobile: document hidden -> the browser stops animation frames; visible ->
 * resumes at the current timeline time.
 *
 * System context:
 * BackgroundTiles / BackgroundPattern provide the grid pattern.
 * GridEnergyPills overlays desktop SVG motion using the same patternOffset.
 * MobileGridEnergyPills keeps the mobile motion off SVG animation (WebKit's
 * bottleneck) and off a full-screen per-frame canvas redraw (iOS heat).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const GRID_SIZE = 143;
const HORIZONTAL_PILL_HEIGHT = 5;
const VERTICAL_PILL_WIDTH = 5;
const DIAMOND_SIZE = 22;
const DIAMOND_HALF = DIAMOND_SIZE / 2;
const MOBILE_VIEWPORT_MAX_WIDTH = 767;
const QUERY_INPUT_MOBILE_CLEARANCE = 260;
const LANDING_CONTROLS_MOBILE_CLEARANCE = 340;
const LARGE_TILE_MASK_SIZE = 426.8;
const LARGE_TILE_MASK_HALF = LARGE_TILE_MASK_SIZE / 2;
const SMALL_DIAMOND_PATH = 'M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z';

interface GridEnergyPillsProps {
  idPrefix: string;
  patternOffset: { x: number; y: number };
  maskId?: string;
  /** Dims every pill streak (Rose dark mode); omit for the stock layer. */
  opacity?: number;
}

interface MobileGridEnergyPillsProps {
  patternOffset: { x: number; y: number };
  selectedAgentId: string | null;
  /** Dims every pill streak (Rose dark mode); omit for the stock layer. */
  opacity?: number;
}

type Flow = {
  id: string;
  axis: 'x' | 'y';
  lineRatio: number;
  length: number;
  duration: number;
  delay: number;
  reverse?: boolean;
};

const FLOWS: Flow[] = [
  { id: 'h-01', axis: 'x', lineRatio: 0.04, length: 66, duration: 10, delay: -1 },
  { id: 'h-02', axis: 'x', lineRatio: 0.1, length: 78, duration: 12, delay: -6, reverse: true },
  { id: 'h-03', axis: 'x', lineRatio: 0.16, length: 58, duration: 9, delay: -3 },
  { id: 'h-04', axis: 'x', lineRatio: 0.22, length: 86, duration: 14, delay: -11, reverse: true },
  { id: 'h-05', axis: 'x', lineRatio: 0.29, length: 70, duration: 11, delay: -8 },
  { id: 'h-06', axis: 'x', lineRatio: 0.35, length: 92, duration: 15, delay: -2, reverse: true },
  { id: 'h-07', axis: 'x', lineRatio: 0.41, length: 62, duration: 10, delay: -7 },
  { id: 'h-08', axis: 'x', lineRatio: 0.47, length: 82, duration: 13, delay: -13, reverse: true },
  { id: 'h-09', axis: 'x', lineRatio: 0.53, length: 74, duration: 12, delay: -4 },
  { id: 'h-10', axis: 'x', lineRatio: 0.59, length: 64, duration: 10, delay: -9, reverse: true },
  { id: 'h-11', axis: 'x', lineRatio: 0.65, length: 88, duration: 14, delay: -5 },
  { id: 'h-12', axis: 'x', lineRatio: 0.71, length: 68, duration: 11, delay: -15, reverse: true },
  { id: 'h-13', axis: 'x', lineRatio: 0.78, length: 94, duration: 15, delay: -10 },
  { id: 'h-14', axis: 'x', lineRatio: 0.84, length: 72, duration: 12, delay: -14, reverse: true },
  { id: 'h-15', axis: 'x', lineRatio: 0.9, length: 60, duration: 9, delay: -6 },
  { id: 'h-16', axis: 'x', lineRatio: 0.96, length: 80, duration: 13, delay: -12, reverse: true },
  { id: 'v-01', axis: 'y', lineRatio: 0.04, length: 70, duration: 11, delay: -5 },
  { id: 'v-02', axis: 'y', lineRatio: 0.11, length: 84, duration: 14, delay: -12, reverse: true },
  { id: 'v-03', axis: 'y', lineRatio: 0.18, length: 62, duration: 10, delay: -2 },
  { id: 'v-04', axis: 'y', lineRatio: 0.25, length: 90, duration: 15, delay: -9, reverse: true },
  { id: 'v-05', axis: 'y', lineRatio: 0.32, length: 74, duration: 12, delay: -7 },
  { id: 'v-06', axis: 'y', lineRatio: 0.39, length: 66, duration: 10, delay: -14, reverse: true },
  { id: 'v-07', axis: 'y', lineRatio: 0.46, length: 88, duration: 14, delay: -4 },
  { id: 'v-08', axis: 'y', lineRatio: 0.54, length: 68, duration: 11, delay: -10, reverse: true },
  { id: 'v-09', axis: 'y', lineRatio: 0.61, length: 82, duration: 13, delay: -1 },
  { id: 'v-10', axis: 'y', lineRatio: 0.68, length: 60, duration: 9, delay: -8, reverse: true },
  { id: 'v-11', axis: 'y', lineRatio: 0.75, length: 92, duration: 15, delay: -13 },
  { id: 'v-12', axis: 'y', lineRatio: 0.82, length: 72, duration: 12, delay: -6, reverse: true },
  { id: 'v-13', axis: 'y', lineRatio: 0.89, length: 86, duration: 14, delay: -11 },
  { id: 'v-14', axis: 'y', lineRatio: 0.96, length: 64, duration: 10, delay: -3, reverse: true },
];

const MOBILE_FLOW_IDS = new Set(['h-01', 'h-05', 'h-09', 'h-13', 'v-02', 'v-06', 'v-10', 'v-14']);
const MOBILE_FLOWS = FLOWS.filter((flow) => MOBILE_FLOW_IDS.has(flow.id));

const viewportSize = (): { width: number; height: number } => {
  if (typeof window === 'undefined') return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
};

const firstGridLineAtOrBeforeZero = (offset: number): number =>
  offset - Math.ceil(offset / GRID_SIZE) * GRID_SIZE;

const gridLineAtRatio = (offset: number, extent: number, ratio: number): number => {
  const firstLine = firstGridLineAtOrBeforeZero(offset);
  const visibleLineCount = Math.ceil(extent / GRID_SIZE) + 2;
  return firstLine + Math.max(0, Math.round(visibleLineCount * ratio)) * GRID_SIZE;
};

const gridLinesForExtent = (offset: number, extent: number): number[] => {
  const firstLine = firstGridLineAtOrBeforeZero(offset) - GRID_SIZE;
  const lineCount = Math.ceil(extent / GRID_SIZE) + 4;
  return Array.from({ length: lineCount }, (_, index) => firstLine + index * GRID_SIZE);
};

export function GridEnergyPills({
  idPrefix,
  patternOffset,
  maskId,
  opacity,
}: GridEnergyPillsProps) {
  const { width, height } = viewportSize();
  const isMobileViewport = width <= MOBILE_VIEWPORT_MAX_WIDTH;
  const flows = isMobileViewport ? MOBILE_FLOWS : FLOWS;
  const minX = -GRID_SIZE;
  const minY = -GRID_SIZE;
  const maxX = width + GRID_SIZE;
  const maxY = height + GRID_SIZE;
  const travelX = maxX - minX;
  const travelY = maxY - minY;
  const maskProps = maskId === undefined ? {} : { mask: `url(#${maskId})` };

  return (
    <g
      className="grid-energy-pill-flow"
      data-flow-count={flows.length}
      {...maskProps}
      opacity={opacity}
    >
      <style>
        {`
          @media (prefers-reduced-motion: reduce) {
            .grid-energy-pill-flow {
              display: none;
            }
          }

          .grid-energy-pill-flow {
            --energy-pill-soft-stop: 0.34;
            --energy-pill-core-stop: 0.95;
            --energy-pill-tail-stop: 0.28;
          }

          .dark .grid-energy-pill-flow {
            --energy-pill-soft-stop: 0.42;
            --energy-pill-core-stop: 1;
            --energy-pill-tail-stop: 0.34;
          }
        `}
      </style>

      <defs>
        {!isMobileViewport && (
          <filter id={`${idPrefix}-soft-glow`} x="-50%" y="-250%" width="200%" height="600%">
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
        )}

        <linearGradient id={`${idPrefix}-energy-x`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
          <stop
            offset="20%"
            stopColor="rgb(255, 255, 255)"
            stopOpacity="var(--energy-pill-soft-stop)"
          />
          <stop
            offset="52%"
            stopColor="rgb(255, 255, 255)"
            stopOpacity="var(--energy-pill-core-stop)"
          />
          <stop
            offset="82%"
            stopColor="rgb(255, 255, 255)"
            stopOpacity="var(--energy-pill-tail-stop)"
          />
          <stop offset="100%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
        </linearGradient>

        <linearGradient id={`${idPrefix}-energy-y`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
          <stop
            offset="20%"
            stopColor="rgb(255, 255, 255)"
            stopOpacity="var(--energy-pill-soft-stop)"
          />
          <stop
            offset="52%"
            stopColor="rgb(255, 255, 255)"
            stopOpacity="var(--energy-pill-core-stop)"
          />
          <stop
            offset="82%"
            stopColor="rgb(255, 255, 255)"
            stopOpacity="var(--energy-pill-tail-stop)"
          />
          <stop offset="100%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {flows.map((flow) => (
        <EnergyPill
          key={flow.id}
          flow={flow}
          width={width}
          height={height}
          minX={minX}
          minY={minY}
          maxX={maxX}
          maxY={maxY}
          travelX={travelX}
          travelY={travelY}
          patternOffset={patternOffset}
          fillX={`url(#${idPrefix}-energy-x)`}
          fillY={`url(#${idPrefix}-energy-y)`}
          filterId={isMobileViewport ? undefined : `${idPrefix}-soft-glow`}
          clipId={`${idPrefix}-${flow.id}-clip`}
        />
      ))}
    </g>
  );
}

export function MobileGridEnergyPills({
  patternOffset,
  selectedAgentId,
  opacity,
}: MobileGridEnergyPillsProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [{ width, height }, setViewport] = useState(viewportSize);

  useEffect(() => {
    const resize = () =>
      setViewport((current) => {
        const next = viewportSize();
        return next.width === current.width && next.height === current.height ? current : next;
      });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const tracks = useMemo(() => {
    const rects = mobileEnergyClipRects(width, height, selectedAgentId);
    return MOBILE_FLOWS.map((flow) =>
      mobileFlowTrack(flow, width, height, patternOffset, rects),
    ).filter((track): track is MobileFlowTrack => track !== null);
  }, [width, height, patternOffset, selectedAgentId]);
  const trackNames = tracks.map((track) => track.name).join(' ');

  // Phase: each pill's CSS animation starts at the document timeline origin, so
  // its progress at time t is ((t / 1000 - flow.delay) % duration) / duration
  // (the former canvas formula). Runs once per keyframe set, never per frame.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || typeof layer.getAnimations !== 'function') return;
    for (const animation of layer.getAnimations({ subtree: true })) animation.startTime = 0;
  }, [trackNames]);

  return (
    <div
      ref={layerRef}
      data-testid="terminal-grid-energy-canvas"
      data-flow-count={tracks.length}
      className="absolute inset-0 overflow-hidden pointer-events-none z-[4]"
      style={{ width, height, clipPath: mobileEnergyClipPath(width, height, selectedAgentId) }}
    >
      <style>{[MOBILE_PILL_STYLES, ...tracks.map((track) => track.keyframes)].join('\n')}</style>
      {tracks.map(({ flow, name }) => (
        <div
          key={flow.id}
          data-flow-id={flow.id}
          className={`${MOBILE_PILL_CLASS} ${MOBILE_PILL_CLASS}-${flow.axis}`}
          style={{
            width: flow.axis === 'x' ? flow.length : VERTICAL_PILL_WIDTH,
            height: flow.axis === 'x' ? HORIZONTAL_PILL_HEIGHT : flow.length,
            animation: `${name} ${flow.duration}s linear ${flow.delay}s infinite`,
            opacity,
          }}
        />
      ))}
    </div>
  );
}

interface EnergyPillProps {
  flow: Flow;
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  travelX: number;
  travelY: number;
  patternOffset: { x: number; y: number };
  fillX: string;
  fillY: string;
  filterId?: string;
  clipId: string;
}

const MOBILE_PILL_CLASS = 'rose-mobile-energy-pill';

const pathNumber = (value: number): string => String(Number(value.toFixed(3)));

const rectSubpath = (x: number, y: number, width: number, height: number): string =>
  `M${pathNumber(x)} ${pathNumber(y)}H${pathNumber(x + width)}V${pathNumber(y + height)}H${pathNumber(x)}Z`;

type ClipRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Even-odd clip of three rects (viewport, large center tile, bottom input
 * area): a pixel shows when an odd number of rects covers it, so the tile and
 * input cutouts hide pills and their overlap shows them again.
 */
const mobileEnergyClipRects = (
  width: number,
  height: number,
  selectedAgentId: string | null,
): ClipRect[] => {
  const inputClearance =
    selectedAgentId === null ? LANDING_CONTROLS_MOBILE_CLEARANCE : QUERY_INPUT_MOBILE_CLEARANCE;
  const inputAreaCutoutY = Math.max(0, height - inputClearance);
  const largeTileX = width / 2 - LARGE_TILE_MASK_HALF;
  const largeTileY = height * 0.4 - LARGE_TILE_MASK_HALF;
  return [
    { x0: 0, y0: 0, x1: width, y1: height },
    {
      x0: largeTileX,
      y0: largeTileY,
      x1: largeTileX + LARGE_TILE_MASK_SIZE,
      y1: largeTileY + LARGE_TILE_MASK_SIZE,
    },
    { x0: 0, y0: inputAreaCutoutY, x1: width, y1: inputAreaCutoutY + inputClearance },
  ];
};

const mobileEnergyClipPath = (
  width: number,
  height: number,
  selectedAgentId: string | null,
): string => {
  const subpaths = mobileEnergyClipRects(width, height, selectedAgentId).map((rect) =>
    rectSubpath(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0),
  );
  return `path(evenodd, '${subpaths.join(' ')}')`;
};

/** A pill within this many px of the visible mask region still counts as
 * visible, so clip-edge antialiasing never loses a partially covered pixel. */
const PILL_VISIBILITY_MARGIN = 2;

/**
 * Along-axis intervals of the layer where some point of the cross band
 * [c0, c1] shows through the even-odd mask (and lies inside the layer, which
 * clips its overflow). Evaluated per cell of the rect-edge grid, where the
 * covering parity is constant.
 */
const visibleAlongIntervals = (
  rects: ClipRect[],
  axis: Flow['axis'],
  width: number,
  height: number,
  c0: number,
  c1: number,
): Array<[number, number]> => {
  const horizontal = axis === 'x';
  const alongExtent = horizontal ? width : height;
  const crossExtent = horizontal ? height : width;
  const cross0 = Math.max(0, c0);
  const cross1 = Math.min(crossExtent, c1);
  if (cross1 <= cross0 || alongExtent <= 0) return [];
  const edges = (lo: number, hi: number, pick: (rect: ClipRect) => number[]) =>
    [...new Set([lo, hi, ...rects.flatMap(pick).filter((v) => v > lo && v < hi)])].sort(
      (a, b) => a - b,
    );
  const alongEdges = edges(0, alongExtent, (r) => (horizontal ? [r.x0, r.x1] : [r.y0, r.y1]));
  const crossEdges = edges(cross0, cross1, (r) => (horizontal ? [r.y0, r.y1] : [r.x0, r.x1]));
  const shows = (along: number, cross: number) => {
    const [x, y] = horizontal ? [along, cross] : [cross, along];
    return rects.filter((r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1).length % 2 === 1;
  };
  const intervals: Array<[number, number]> = [];
  for (let i = 0; i < alongEdges.length - 1; i += 1) {
    const [a0, a1] = [alongEdges[i], alongEdges[i + 1]];
    let visible = false;
    for (let j = 0; j < crossEdges.length - 1 && !visible; j += 1) {
      visible = shows((a0 + a1) / 2, (crossEdges[j] + crossEdges[j + 1]) / 2);
    }
    if (!visible) continue;
    const last = intervals[intervals.length - 1];
    if (last && last[1] === a0) last[1] = a1;
    else intervals.push([a0, a1]);
  }
  return intervals;
};

const hashString = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

interface MobileFlowTrack {
  flow: Flow;
  name: string;
  keyframes: string;
}

/**
 * One pill's keyframes: an off-screen start to an off-screen end along its
 * flow axis (reverse flows run back), sitting on its grid line. The whole
 * position lives in the transform, so layout never snaps the line coordinate.
 *
 * Only the cycle fractions where the pill can show through the mask follow
 * that linear path; in between the pill holds where it was masked
 * (step-end) and jumps to its re-entry point, so the compositor sees no
 * motion while nothing visible changes. Returns null when the pill never
 * shows at all. Every visible frame is the same position as the plain
 * from -> to animation at the same time.
 */
const mobileFlowTrack = (
  flow: Flow,
  width: number,
  height: number,
  patternOffset: { x: number; y: number },
  rects: ClipRect[],
): MobileFlowTrack | null => {
  const horizontal = flow.axis === 'x';
  const extent = horizontal ? width : height;
  const travel = extent + GRID_SIZE * 2;
  const start = flow.reverse ? extent + GRID_SIZE : -GRID_SIZE - flow.length;
  const end = start + (flow.reverse ? -travel - flow.length : travel + flow.length);
  const line = horizontal
    ? gridLineAtRatio(patternOffset.y, height, flow.lineRatio) - HORIZONTAL_PILL_HEIGHT / 2
    : gridLineAtRatio(patternOffset.x, width, flow.lineRatio) - VERTICAL_PILL_WIDTH / 2;
  const thickness = horizontal ? HORIZONTAL_PILL_HEIGHT : VERTICAL_PILL_WIDTH;
  const at = (along: number): string =>
    horizontal
      ? `translate3d(${pathNumber(along)}px, ${pathNumber(line)}px, 0)`
      : `translate3d(${pathNumber(line)}px, ${pathNumber(along)}px, 0)`;
  // The pill's leading coordinate `along` shows when [along, along + length]
  // overlaps a visible interval; map those along ranges to cycle fractions.
  const span = end - start;
  const windows = visibleAlongIntervals(
    rects,
    flow.axis,
    width,
    height,
    line - PILL_VISIBILITY_MARGIN,
    line + thickness + PILL_VISIBILITY_MARGIN,
  )
    .map(([v0, v1]) => {
      const f0 = (v0 - flow.length - PILL_VISIBILITY_MARGIN - start) / span;
      const f1 = (v1 + PILL_VISIBILITY_MARGIN - start) / span;
      return [Math.max(0, Math.min(f0, f1)), Math.min(1, Math.max(f0, f1))];
    })
    .filter(([f0, f1]) => f1 > f0)
    .sort((a, b) => a[0] - b[0])
    .reduce<number[][]>((merged, window) => {
      const last = merged[merged.length - 1];
      if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
      else merged.push([...window]);
      return merged;
    }, []);
  if (windows.length === 0) return null;

  const position = (fraction: number) => start + fraction * span;
  const offset = (fraction: number) => `${Number((fraction * 100).toFixed(6))}%`;
  const frames: string[] = [];
  if (windows[0][0] > 0) frames.push(`0% { transform: ${at(position(windows[0][0]))}; }`);
  windows.forEach(([f0, f1], index) => {
    frames.push(`${offset(f0)} { transform: ${at(position(f0))}; }`);
    const hold = index < windows.length - 1 ? ' animation-timing-function: step-end;' : '';
    frames.push(`${offset(f1)} { transform: ${at(position(f1))};${hold} }`);
  });
  const last = windows[windows.length - 1][1];
  if (last < 1) frames.push(`100% { transform: ${at(position(last))}; }`);
  const body = frames.join(' ');
  const name = `${MOBILE_PILL_CLASS}-${flow.id}-${hashString(body)}`;
  return { flow, name, keyframes: `@keyframes ${name} { ${body} }` };
};

const pillGradient = (direction: string): string =>
  `linear-gradient(${direction}, rgba(255, 255, 255, 0) 0%, ` +
  'rgba(255, 255, 255, var(--energy-pill-soft-stop)) 20%, ' +
  'rgba(255, 255, 255, var(--energy-pill-core-stop)) 52%, ' +
  'rgba(255, 255, 255, var(--energy-pill-tail-stop)) 82%, rgba(255, 255, 255, 0) 100%)';

/** Theme stops match the desktop SVG gradient; html.dark switches them in CSS. */
const MOBILE_PILL_STYLES = [
  `.${MOBILE_PILL_CLASS} { position: absolute; left: 0; top: 0; ` +
    `border-radius: ${HORIZONTAL_PILL_HEIGHT / 2}px; --energy-pill-soft-stop: 0.34; ` +
    '--energy-pill-core-stop: 0.95; --energy-pill-tail-stop: 0.28; }',
  `:root.dark .${MOBILE_PILL_CLASS} { --energy-pill-soft-stop: 0.42; ` +
    '--energy-pill-core-stop: 1; --energy-pill-tail-stop: 0.34; }',
  `.${MOBILE_PILL_CLASS}-x { background-image: ${pillGradient('to right')}; }`,
  `.${MOBILE_PILL_CLASS}-y { background-image: ${pillGradient('to bottom')}; }`,
].join('\n');

function EnergyPill({
  flow,
  width,
  height,
  minX,
  minY,
  maxX,
  maxY,
  travelX,
  travelY,
  patternOffset,
  fillX,
  fillY,
  filterId,
  clipId,
}: EnergyPillProps) {
  if (flow.axis === 'x') {
    const x = flow.reverse ? maxX : minX - flow.length;
    const lineY = gridLineAtRatio(patternOffset.y, height, flow.lineRatio);
    const y = lineY - DIAMOND_HALF;
    const to = flow.reverse ? -travelX - flow.length : travelX + flow.length;
    const intersectionXs = gridLinesForExtent(patternOffset.x, width);

    return (
      <>
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <rect
              x={minX - flow.length}
              y={lineY - HORIZONTAL_PILL_HEIGHT / 2}
              width={travelX + flow.length * 2}
              height={HORIZONTAL_PILL_HEIGHT}
            />
            {intersectionXs.map((intersectionX) => (
              <path
                key={intersectionX}
                d={SMALL_DIAMOND_PATH}
                transform={`translate(${intersectionX} ${lineY})`}
              />
            ))}
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          <g>
            {filterId !== undefined && (
              <rect
                x={x}
                y={y}
                width={flow.length}
                height={DIAMOND_SIZE}
                rx={DIAMOND_HALF}
                fill={fillX}
                opacity="0.95"
                filter={`url(#${filterId})`}
              />
            )}
            <rect
              x={x}
              y={y}
              width={flow.length}
              height={DIAMOND_SIZE}
              rx={DIAMOND_HALF}
              fill={fillX}
              opacity="1"
            />
            <animateTransform
              attributeName="transform"
              type="translate"
              from="0 0"
              to={`${to} 0`}
              dur={`${flow.duration}s`}
              begin={`${flow.delay}s`}
              repeatCount="indefinite"
            />
          </g>
        </g>
      </>
    );
  }

  const x = gridLineAtRatio(patternOffset.x, width, flow.lineRatio) - VERTICAL_PILL_WIDTH / 2;
  const lineX = x + VERTICAL_PILL_WIDTH / 2;
  const y = flow.reverse ? maxY : minY - flow.length;
  const to = flow.reverse ? -travelY - flow.length : travelY + flow.length;
  const intersectionYs = gridLinesForExtent(patternOffset.y, height);

  return (
    <>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <rect
            x={lineX - VERTICAL_PILL_WIDTH / 2}
            y={minY - flow.length}
            width={VERTICAL_PILL_WIDTH}
            height={travelY + flow.length * 2}
          />
          {intersectionYs.map((intersectionY) => (
            <path
              key={intersectionY}
              d={SMALL_DIAMOND_PATH}
              transform={`translate(${lineX} ${intersectionY})`}
            />
          ))}
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        <g>
          {filterId !== undefined && (
            <rect
              x={lineX - DIAMOND_HALF}
              y={y}
              width={DIAMOND_SIZE}
              height={flow.length}
              rx={DIAMOND_HALF}
              fill={fillY}
              opacity="0.95"
              filter={`url(#${filterId})`}
            />
          )}
          <rect
            x={lineX - DIAMOND_HALF}
            y={y}
            width={DIAMOND_SIZE}
            height={flow.length}
            rx={DIAMOND_HALF}
            fill={fillY}
            opacity="1"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            from="0 0"
            to={`0 ${to}`}
            dur={`${flow.duration}s`}
            begin={`${flow.delay}s`}
            repeatCount="indefinite"
          />
        </g>
      </g>
    </>
  );
}
