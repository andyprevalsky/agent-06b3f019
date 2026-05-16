/**
 * STATE MACHINE: GridEnergyPills
 *
 * GEOMETRY:
 * [MEASURE_VIEWPORT] --> derives visible grid-line coordinates from patternOffset
 *   |
 *   v
 * [RENDER_FLOWS] --> draws deterministic SVG pill paths on existing grid lines
 *
 * MOTION:
 * [FLOWING] --> SVG animateTransform moves each pill along a grid line
 *   |
 *   v (prefers-reduced-motion: reduce)
 * [HIDDEN] --> CSS hides animated pills
 *
 * System context:
 * BackgroundTiles / BackgroundPattern provide the grid pattern.
 * GridEnergyPills overlays light, diffused motion using the same patternOffset.
 */

const GRID_SIZE = 143;
const HORIZONTAL_PILL_HEIGHT = 5;
const VERTICAL_PILL_WIDTH = 5;
const DIAMOND_SIZE = 22;
const DIAMOND_HALF = DIAMOND_SIZE / 2;
const SMALL_DIAMOND_PATH = 'M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z';

interface GridEnergyPillsProps {
  idPrefix: string;
  patternOffset: { x: number; y: number };
  maskId?: string;
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

export function GridEnergyPills({ idPrefix, patternOffset, maskId }: GridEnergyPillsProps) {
  const { width, height } = viewportSize();
  const minX = -GRID_SIZE;
  const minY = -GRID_SIZE;
  const maxX = width + GRID_SIZE;
  const maxY = height + GRID_SIZE;
  const travelX = maxX - minX;
  const travelY = maxY - minY;
  const maskProps = maskId === undefined ? {} : { mask: `url(#${maskId})` };

  return (
    <g className="grid-energy-pill-flow" {...maskProps}>
      <style>
        {`
          @media (prefers-reduced-motion: reduce) {
            .grid-energy-pill-flow {
              display: none;
            }
          }
        `}
      </style>

      <defs>
        <filter id={`${idPrefix}-soft-glow`} x="-50%" y="-250%" width="200%" height="600%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>

        <linearGradient id={`${idPrefix}-light-x`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
          <stop offset="20%" stopColor="rgb(255, 255, 255)" stopOpacity="0.34" />
          <stop offset="52%" stopColor="rgb(255, 255, 255)" stopOpacity="0.95" />
          <stop offset="82%" stopColor="rgb(255, 255, 255)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
        </linearGradient>

        <linearGradient id={`${idPrefix}-light-y`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
          <stop offset="20%" stopColor="rgb(255, 255, 255)" stopOpacity="0.34" />
          <stop offset="52%" stopColor="rgb(255, 255, 255)" stopOpacity="0.95" />
          <stop offset="82%" stopColor="rgb(255, 255, 255)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
        </linearGradient>

        <linearGradient id={`${idPrefix}-dark-x`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
          <stop offset="20%" stopColor="rgb(255, 255, 255)" stopOpacity="0.42" />
          <stop offset="52%" stopColor="rgb(255, 255, 255)" stopOpacity="1" />
          <stop offset="82%" stopColor="rgb(255, 255, 255)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
        </linearGradient>

        <linearGradient id={`${idPrefix}-dark-y`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
          <stop offset="20%" stopColor="rgb(255, 255, 255)" stopOpacity="0.42" />
          <stop offset="52%" stopColor="rgb(255, 255, 255)" stopOpacity="1" />
          <stop offset="82%" stopColor="rgb(255, 255, 255)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="rgb(255, 255, 255)" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className="dark:hidden">
        {FLOWS.map((flow) => (
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
            fillX={`url(#${idPrefix}-light-x)`}
            fillY={`url(#${idPrefix}-light-y)`}
            filterId={`${idPrefix}-soft-glow`}
            clipId={`${idPrefix}-${flow.id}-clip-light`}
          />
        ))}
      </g>

      <g className="hidden dark:inline">
        {FLOWS.map((flow) => (
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
            fillX={`url(#${idPrefix}-dark-x)`}
            fillY={`url(#${idPrefix}-dark-y)`}
            filterId={`${idPrefix}-soft-glow`}
            clipId={`${idPrefix}-${flow.id}-clip-dark`}
          />
        ))}
      </g>
    </g>
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
  filterId: string;
  clipId: string;
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
