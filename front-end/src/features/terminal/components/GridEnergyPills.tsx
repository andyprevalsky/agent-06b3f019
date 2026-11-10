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
 * [LEAN_FLOWING] --> 8 flows, no blur filter; each pill is a CSS keyframe
 *                    translate3d animation (compositor-driven, no per-frame JS)
 *                    whose start time is pinned to the document timeline origin
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

  const tracks = useMemo(
    () => MOBILE_FLOWS.map((flow) => mobileFlowTrack(flow, width, height, patternOffset)),
    [width, height, patternOffset],
  );
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
      data-flow-count={MOBILE_FLOWS.length}
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

/**
 * Even-odd clip of three rects (viewport, large center tile, bottom input
 * area): a pixel shows when an odd number of rects covers it, so the tile and
 * input cutouts hide pills and their overlap shows them again.
 */
const mobileEnergyClipPath = (
  width: number,
  height: number,
  selectedAgentId: string | null,
): string => {
  const inputClearance =
    selectedAgentId === null ? LANDING_CONTROLS_MOBILE_CLEARANCE : QUERY_INPUT_MOBILE_CLEARANCE;
  const inputAreaCutoutY = Math.max(0, height - inputClearance);
  const largeTileX = width / 2 - LARGE_TILE_MASK_HALF;
  const largeTileY = height * 0.4 - LARGE_TILE_MASK_HALF;
  const subpaths = [
    rectSubpath(0, 0, width, height),
    rectSubpath(largeTileX, largeTileY, LARGE_TILE_MASK_SIZE, LARGE_TILE_MASK_SIZE),
    rectSubpath(0, inputAreaCutoutY, width, inputClearance),
  ];
  return `path(evenodd, '${subpaths.join(' ')}')`;
};

const hashString = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/**
 * One pill's keyframes: an off-screen start to an off-screen end along its
 * flow axis (reverse flows run back), sitting on its grid line. The whole
 * position lives in the transform, so layout never snaps the line coordinate.
 */
const mobileFlowTrack = (
  flow: Flow,
  width: number,
  height: number,
  patternOffset: { x: number; y: number },
): { flow: Flow; name: string; keyframes: string } => {
  const horizontal = flow.axis === 'x';
  const extent = horizontal ? width : height;
  const travel = extent + GRID_SIZE * 2;
  const start = flow.reverse ? extent + GRID_SIZE : -GRID_SIZE - flow.length;
  const end = start + (flow.reverse ? -travel - flow.length : travel + flow.length);
  const line = horizontal
    ? gridLineAtRatio(patternOffset.y, height, flow.lineRatio) - HORIZONTAL_PILL_HEIGHT / 2
    : gridLineAtRatio(patternOffset.x, width, flow.lineRatio) - VERTICAL_PILL_WIDTH / 2;
  const at = (along: number): string =>
    horizontal
      ? `translate3d(${pathNumber(along)}px, ${pathNumber(line)}px, 0)`
      : `translate3d(${pathNumber(line)}px, ${pathNumber(along)}px, 0)`;
  const from = at(start);
  const to = at(end);
  const name = `${MOBILE_PILL_CLASS}-${flow.id}-${hashString(`${from} ${to}`)}`;
  return {
    flow,
    name,
    keyframes: `@keyframes ${name} { from { transform: ${from}; } to { transform: ${to}; } }`,
  };
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
