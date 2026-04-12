/**
 * STATE MACHINE: BackgroundPattern
 *
 * STATIC: Renders SVG grid pattern, animated tile overlays,
 *         large tile border, and corner decorations.
 *         No internal state transitions — purely derived from props.
 */

import { SmallTileAnimationCanvas } from '@/features/terminal-component-group';

interface BackgroundPatternProps {
  patternOffset: { x: number; y: number };
  tileColors: Map<string, number>;
  colorPalette: Array<{ hex: string }>;
  animationResetKey: number;
  animationComplete: boolean;
  currentFrame: number;
  selectedAgentId: string | null;
}

export function BackgroundPattern({
  patternOffset,
  tileColors,
  colorPalette,
  animationResetKey,
  animationComplete,
  currentFrame,
  selectedAgentId,
}: BackgroundPatternProps) {
  return (
    <>
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none z-[3]"
        xmlns="http://www.w3.org/2000/svg"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
      >
        <PatternDefs patternOffset={patternOffset} />
        <AnimatedTilesOverlay tileColors={tileColors} colorPalette={colorPalette} />
        <SmallTilesBackground />
        <LargeTileBorder />
        <LargeTileCorners />
      </svg>

      <SmallTileAnimationCanvas
        key={animationResetKey}
        enabled={true}
        tileAnimationComplete={animationComplete}
        currentFrame={currentFrame}
        tileColors={tileColors}
        selectedAgentId={selectedAgentId}
      />
    </>
  );
}

// ── SVG <defs> (gradient, pattern, mask) ────────────────────────────────

function PatternDefs({ patternOffset }: { patternOffset: { x: number; y: number } }) {
  return (
    <defs>
      <linearGradient id="rose-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#FE7503" />
        <stop offset="20%" stopColor="#FC585C" />
        <stop offset="40%" stopColor="#FD5776" />
        <stop offset="60%" stopColor="#E062CC" />
        <stop offset="80%" stopColor="#A76CED" />
        <stop offset="100%" stopColor="#7A6BEC" />
      </linearGradient>

      <pattern
        id="grid-pattern"
        x={patternOffset.x}
        y={patternOffset.y}
        width="143"
        height="143"
        patternUnits="userSpaceOnUse"
      >
        <rect x="0" y="0" width="143" height="143" fill="transparent" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" />
        <path d="M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
        <path d="M 143,-11 Q 143,0 154,0 Q 143,0 143,11 Q 143,0 132,0 Q 143,0 143,-11 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
        <path d="M 0,132 Q 0,143 11,143 Q 0,143 0,154 Q 0,143 -11,143 Q 0,143 0,132 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
        <path d="M 143,132 Q 143,143 154,143 Q 143,143 143,154 Q 143,143 132,143 Q 143,143 143,132 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
      </pattern>

      <mask id="large-tile-mask">
        <rect x="-5000" y="-5000" width="10000" height="10000" fill="white" />
        <rect x="50%" y="40%" width="426.8" height="426.8" style={{ transform: 'translate(-213.4px, -213.4px)' }} fill="black" />
      </mask>
    </defs>
  );
}

// ── Colored tile rects from the animation state ─────────────────────────

function AnimatedTilesOverlay({ tileColors, colorPalette }: { tileColors: Map<string, number>; colorPalette: Array<{ hex: string }> }) {
  return (
    <>
      {Array.from(tileColors.entries()).map(([key, colorId]) => {
        const [row, col] = key.split(',').map(Number);
        const color = colorPalette[colorId];
        const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
        const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
        const centerX = viewportWidth / 2;
        const centerY = viewportHeight * 0.4;
        const tileSize = 143;
        const largeTileSize = 429;
        const largeTileHalf = largeTileSize / 2;
        const tilesLeft = Math.floor((centerX - largeTileHalf) / tileSize);
        const tilesUp = Math.floor((centerY - largeTileHalf) / tileSize);
        const gridOriginX = centerX - largeTileHalf - tilesLeft * tileSize;
        const gridOriginY = centerY - largeTileHalf - tilesUp * tileSize;
        const x = gridOriginX + col * tileSize;
        const y = gridOriginY + row * tileSize;

        return <rect key={key} x={x} y={y} width={tileSize} height={tileSize} fill={colorId === 0 ? 'transparent' : color.hex} />;
      })}
    </>
  );
}

// ── Full-size grid + large tile border ──────────────────────────────────

function SmallTilesBackground() {
  return <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#grid-pattern)" mask="url(#large-tile-mask)" />;
}

function LargeTileBorder() {
  return (
    <rect x="50%" y="40%" width="429" height="429" style={{ transform: 'translate(-214.5px, -214.5px)' }} fill="none" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" />
  );
}

// ── Corner diamonds + circles ───────────────────────────────────────────

const DIAMOND_PATH = 'M 0.5,-12 L 0.5,-6 C 0.5,-4 2,-2 4,-1 L 6,-0.5 L 12,-0.5 L 12,0.5 L 6,0.5 L 4,1 C 2,2 0.5,4 0.5,6 L 0.5,12 L -0.5,12 L -0.5,6 C -0.5,4 -2,2 -4,1 L -6,0.5 L -12,0.5 L -12,-0.5 L -6,-0.5 L -4,-1 C -2,-2 -0.5,-4 -0.5,-6 L -0.5,-12 Z';
const SMALL_DIAMOND_PATH = 'M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z';

function LargeTileCorners() {
  return (
    <>
      <circle cx="0" cy="0" r="25" fill="none" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" style={{ transform: 'translate(calc(50% - 214.5px), calc(40% - 214.5px))' }} />
      <path d={DIAMOND_PATH} fill="url(#rose-gradient)" style={{ transform: 'translate(calc(50% - 214.5px), calc(40% - 214.5px))' }} />
      <circle cx="0" cy="0" r="25" fill="none" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }} />
      <path d={DIAMOND_PATH} fill="url(#rose-gradient)" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }} />
      <path d={SMALL_DIAMOND_PATH} fill="rgb(229, 231, 235)" className="dark:fill-gray-800" style={{ transform: 'translate(calc(50% - 214.5px), calc(40% + 214.5px))' }} />
      <path d={SMALL_DIAMOND_PATH} fill="rgb(229, 231, 235)" className="dark:fill-gray-800" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% + 214.5px))' }} />
    </>
  );
}
