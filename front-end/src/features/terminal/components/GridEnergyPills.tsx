/**
 * STATE MACHINE: GridEnergyPills
 *
 * GEOMETRY:
 * [MEASURE_VIEWPORT] --> derives visible grid-line coordinates from patternOffset
 *   |
 *   v
 * [SELECT_FLOW_BUDGET] --> keeps the full desktop layer and a reduced mobile layer
 *   |
 *   v
 * [RENDER_ACTIVE_THEME_FLOWS] --> draws one SVG tree with theme-aware gradients
 *
 * THEME:
 * [STOCK]  --> opacity prop absent: no group opacity / canvas alpha (unchanged)
 * [DIMMED] --> opacity prop set (Rose dark mode): SVG group opacity attribute,
 *              canvas globalAlpha for the mobile renderer
 * A theme switch repaints in the same commit: the SVG attribute updates with
 * the render and the mobile canvas paints one frame synchronously in a layout
 * effect (after html.dark has flipped), not on its next animation tick.
 *
 * MOTION:
 * [FLOWING] --> SVG animateTransform moves each pill along a grid line
 *   |
 *   v (mobile viewport)
 * [LEAN_FLOWING] --> uses fewer flows without the desktop blur filter
 *   |
 *   v (prefers-reduced-motion: reduce)
 * [HIDDEN] --> CSS hides animated pills
 *
 * System context:
 * BackgroundTiles / BackgroundPattern provide the grid pattern.
 * GridEnergyPills overlays desktop SVG motion using the same patternOffset.
 * MobileGridEnergyPillsCanvas keeps the mobile motion in canvas to avoid
 * WebKit's SVG animation bottleneck.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

const GRID_SIZE = 143;
const HORIZONTAL_PILL_HEIGHT = 5;
const VERTICAL_PILL_WIDTH = 5;
const DIAMOND_SIZE = 22;
const DIAMOND_HALF = DIAMOND_SIZE / 2;
const MOBILE_VIEWPORT_MAX_WIDTH = 767;
const MOBILE_CANVAS_DPR_MAX = 2;
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

interface MobileGridEnergyPillsCanvasProps {
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

export function MobileGridEnergyPillsCanvas({
  patternOffset,
  selectedAgentId,
  opacity,
}: MobileGridEnergyPillsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const patternOffsetRef = useRef(patternOffset);
  const selectedAgentIdRef = useRef(selectedAgentId);
  const opacityRef = useRef(opacity);
  const paintRef = useRef<((now: number) => void) | null>(null);

  // Theme switch: repaint now, on the frame html.dark flips (no-op on mount).
  useLayoutEffect(() => {
    if (opacityRef.current === opacity) return;
    opacityRef.current = opacity;
    paintRef.current?.(performance.now());
  }, [opacity]);

  useEffect(() => {
    patternOffsetRef.current = patternOffset;
  }, [patternOffset]);

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !ctx) return;

    let animationFrame = 0;

    const resize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, MOBILE_CANVAS_DPR_MAX);
      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const paint = (now: number) => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      applyMobileEnergyMask(ctx, width, height, selectedAgentIdRef.current);
      if (opacityRef.current !== undefined) ctx.globalAlpha = opacityRef.current;

      const darkMode = document.documentElement.classList.contains('dark');
      const softStop = darkMode ? 0.42 : 0.34;
      const coreStop = darkMode ? 1 : 0.95;
      const tailStop = darkMode ? 0.34 : 0.28;
      const minX = -GRID_SIZE;
      const minY = -GRID_SIZE;
      const maxX = width + GRID_SIZE;
      const maxY = height + GRID_SIZE;
      const travelX = maxX - minX;
      const travelY = maxY - minY;

      for (const flow of MOBILE_FLOWS) {
        drawMobileEnergyFlow(ctx, {
          flow,
          now,
          width,
          height,
          minX,
          minY,
          maxX,
          maxY,
          travelX,
          travelY,
          patternOffset: patternOffsetRef.current,
          softStop,
          coreStop,
          tailStop,
        });
      }

      ctx.restore();
    };

    const draw = (now: number) => {
      paint(now);
      animationFrame = window.requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    paintRef.current = paint;
    animationFrame = window.requestAnimationFrame(draw);

    return () => {
      paintRef.current = null;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="terminal-grid-energy-canvas"
      className="absolute inset-0 w-full h-full pointer-events-none z-[4]"
    />
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

type MobileDrawParams = {
  flow: Flow;
  now: number;
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  travelX: number;
  travelY: number;
  patternOffset: { x: number; y: number };
  softStop: number;
  coreStop: number;
  tailStop: number;
};

const roundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
};

const applyMobileEnergyMask = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  selectedAgentId: string | null,
) => {
  const inputClearance =
    selectedAgentId === null ? LANDING_CONTROLS_MOBILE_CLEARANCE : QUERY_INPUT_MOBILE_CLEARANCE;
  const inputAreaCutoutY = Math.max(0, height - inputClearance);
  const largeTileX = width / 2 - LARGE_TILE_MASK_HALF;
  const largeTileY = height * 0.4 - LARGE_TILE_MASK_HALF;

  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(largeTileX, largeTileY, LARGE_TILE_MASK_SIZE, LARGE_TILE_MASK_SIZE);
  ctx.rect(0, inputAreaCutoutY, width, inputClearance);
  ctx.clip('evenodd');
};

const flowProgress = (flow: Flow, now: number): number => {
  const elapsedSeconds = now / 1000 - flow.delay;
  return (elapsedSeconds % flow.duration) / flow.duration;
};

const addGradientStops = (
  gradient: CanvasGradient,
  softStop: number,
  coreStop: number,
  tailStop: number,
) => {
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(0.2, `rgba(255, 255, 255, ${softStop})`);
  gradient.addColorStop(0.52, `rgba(255, 255, 255, ${coreStop})`);
  gradient.addColorStop(0.82, `rgba(255, 255, 255, ${tailStop})`);
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
};

function drawMobileEnergyFlow(
  ctx: CanvasRenderingContext2D,
  {
    flow,
    now,
    width,
    height,
    minX,
    minY,
    maxX,
    maxY,
    travelX,
    travelY,
    patternOffset,
    softStop,
    coreStop,
    tailStop,
  }: MobileDrawParams,
) {
  const progress = flowProgress(flow, now);

  if (flow.axis === 'x') {
    const startX = flow.reverse ? maxX : minX - flow.length;
    const to = flow.reverse ? -travelX - flow.length : travelX + flow.length;
    const x = startX + to * progress;
    const lineY = gridLineAtRatio(patternOffset.y, height, flow.lineRatio);
    const y = lineY - HORIZONTAL_PILL_HEIGHT / 2;
    const gradient = ctx.createLinearGradient(x, lineY, x + flow.length, lineY);
    addGradientStops(gradient, softStop, coreStop, tailStop);
    roundedRect(ctx, x, y, flow.length, HORIZONTAL_PILL_HEIGHT, HORIZONTAL_PILL_HEIGHT / 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    return;
  }

  const lineX = gridLineAtRatio(patternOffset.x, width, flow.lineRatio);
  const startY = flow.reverse ? maxY : minY - flow.length;
  const to = flow.reverse ? -travelY - flow.length : travelY + flow.length;
  const y = startY + to * progress;
  const x = lineX - VERTICAL_PILL_WIDTH / 2;
  const gradient = ctx.createLinearGradient(lineX, y, lineX, y + flow.length);
  addGradientStops(gradient, softStop, coreStop, tailStop);
  roundedRect(ctx, x, y, VERTICAL_PILL_WIDTH, flow.length, VERTICAL_PILL_WIDTH / 2);
  ctx.fillStyle = gradient;
  ctx.fill();
}

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
