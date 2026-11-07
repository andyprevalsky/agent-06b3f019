/**
 * STATE MACHINE: BackgroundPattern
 *
 * STATIC: Renders SVG grid pattern, energy pills, animated tile overlays,
 *         large tile border, and corner decorations.
 *         No internal state transitions — purely derived from props.
 *
 * ENERGY MASK:
 *   AGENT_SELECTED    → clip energy below the query input chrome
 *   NO_AGENT_SELECTED → clip energy below the taller landing controls
 *
 * ENERGY RENDERER:
 *   DESKTOP → SVG energy pills
 *   MOBILE  → CSS-animated (compositor) energy pills: no iOS WebKit SVG
 *             animation jank and no full-screen per-frame canvas redraw
 *
 * SMALL TILE ANIMATION:
 *   DESKTOP → render decorative square/dot animation canvas
 *   MOBILE  → do not mount the square/dot animation canvas
 *
 * THEME (useRoseTheme; Rose Desktop dark mode):
 *   LIGHT → STOCK_GRID_TONE: the original markup, byte-identical (asserted by
 *           rose-theme.blackbox against markup frozen before dark mode); the
 *           grid svg is keyed by theme so a dark -> light switch remounts it
 *   DARK  → calm background: no intro tile overlay, small tile animation + dot
 *           canvas hidden (same render), cleared and not drawn, spawning
 *           stopped; un-hiding repaints the light dots in that commit; grid lines + main
 *           tile border + sparkle circles + small diamonds one neutral silver
 *           (never blue) at the same low opacity, energy pills dimmed
 *   SWITCH → instant: every layer changes in the commit that flips html.dark
 *            (no CSS fades; canvases repaint synchronously and the mobile
 *            energy pills restyle from html.dark, not on the next tick)
 *
 * LAYER CONTRACT:
 * [CANVAS_ANIMATION z-2] -> [GRID_BACKGROUND z-3] -> [ENERGY_PILLS z-4]
 * -> [PAGE_CONTENT z-4, later sibling] -> [CHROME z-50]
 */

import { SmallTileAnimationCanvas } from '@/features/terminal-component-group';
import { useRoseTheme } from '@/features/rose-theme';

import {
  ROSE_DARK_ENERGY_OPACITY,
  ROSE_DARK_GRID_TONE,
  STOCK_GRID_TONE,
  type GridTone,
} from './backgroundGridTone';
import { GridEnergyPills, MobileGridEnergyPills } from './GridEnergyPills';
import { LargeTileBorder, LargeTileCorners } from './LargeTileDecorations';

const QUERY_INPUT_CLEARANCE = {
  desktop: 220,
  mobile: 260,
} as const;

const LANDING_CONTROLS_CLEARANCE = {
  desktop: 300,
  mobile: 340,
} as const;

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
  const isMobileViewport = typeof window !== 'undefined' && window.innerWidth < 768;
  const { isDark } = useRoseTheme();
  const tone = isDark ? ROSE_DARK_GRID_TONE : STOCK_GRID_TONE;
  const energyOpacity = isDark ? ROSE_DARK_ENERGY_OPACITY : undefined;

  return (
    <>
      {/* Keyed by theme: switching remounts the grid, so light is rebuilt fresh
          (identical attributes in identical order) instead of patched. */}
      <svg
        key={isDark ? 'rose-dark' : 'stock'}
        data-testid="terminal-grid-background-layer"
        className="absolute inset-0 w-full h-full pointer-events-none z-[3]"
        xmlns="http://www.w3.org/2000/svg"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
      >
        <PatternDefs patternOffset={patternOffset} tone={tone} />
        {!isDark && <AnimatedTilesOverlay tileColors={tileColors} colorPalette={colorPalette} />}
        <SmallTilesBackground tone={tone} />
        <LargeTileBorder tone={tone} />
        <LargeTileCorners tone={tone} />
      </svg>

      {isMobileViewport ? (
        <MobileGridEnergyPills
          patternOffset={patternOffset}
          selectedAgentId={selectedAgentId}
          opacity={energyOpacity}
        />
      ) : (
        <svg
          data-testid="terminal-grid-energy-layer"
          className="absolute inset-0 w-full h-full pointer-events-none z-[4]"
          xmlns="http://www.w3.org/2000/svg"
          style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
        >
          <TerminalEnergyMask selectedAgentId={selectedAgentId} />
          <GridEnergyPills
            idPrefix="terminal-grid-energy"
            patternOffset={patternOffset}
            maskId="terminal-energy-large-tile-mask"
            opacity={energyOpacity}
          />
        </svg>
      )}

      {!isMobileViewport && (
        <SmallTileAnimationCanvas
          key={animationResetKey}
          enabled={true}
          hidden={isDark || undefined}
          tileAnimationComplete={animationComplete}
          currentFrame={currentFrame}
          tileColors={tileColors}
          selectedAgentId={selectedAgentId}
        />
      )}
    </>
  );
}

function TerminalEnergyMask({ selectedAgentId }: { selectedAgentId: string | null }) {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
  const isMobile = viewportWidth < 768;
  const clearanceByViewport =
    selectedAgentId === null ? LANDING_CONTROLS_CLEARANCE : QUERY_INPUT_CLEARANCE;
  const clearance = isMobile ? clearanceByViewport.mobile : clearanceByViewport.desktop;
  const inputAreaCutoutY = Math.max(0, viewportHeight - clearance);

  return (
    <defs>
      <mask id="terminal-energy-large-tile-mask">
        <rect x="-5000" y="-5000" width="10000" height="10000" fill="white" />
        <rect
          x="50%"
          y="40%"
          width="426.8"
          height="426.8"
          style={{ transform: 'translate(-213.4px, -213.4px)' }}
          fill="black"
        />
        <rect
          data-testid="terminal-energy-input-area-mask"
          x="-5000"
          y={inputAreaCutoutY}
          width="10000"
          height={clearance + 5000}
          fill="black"
        />
      </mask>
    </defs>
  );
}

// ── SVG <defs> (gradient, pattern, mask) ────────────────────────────────

function PatternDefs({
  patternOffset,
  tone,
}: {
  patternOffset: { x: number; y: number };
  tone: GridTone;
}) {
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
        <rect
          x="0"
          y="0"
          width="143"
          height="143"
          fill="transparent"
          stroke={tone.color}
          strokeWidth="1"
          className={tone.strokeClassName}
        />
        <path
          d="M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z"
          fill={tone.color}
          className={tone.fillClassName}
        />
        <path
          d="M 143,-11 Q 143,0 154,0 Q 143,0 143,11 Q 143,0 132,0 Q 143,0 143,-11 Z"
          fill={tone.color}
          className={tone.fillClassName}
        />
        <path
          d="M 0,132 Q 0,143 11,143 Q 0,143 0,154 Q 0,143 -11,143 Q 0,143 0,132 Z"
          fill={tone.color}
          className={tone.fillClassName}
        />
        <path
          d="M 143,132 Q 143,143 154,143 Q 143,143 143,154 Q 143,143 132,143 Q 143,143 143,132 Z"
          fill={tone.color}
          className={tone.fillClassName}
        />
      </pattern>

      <mask id="large-tile-mask">
        <rect x="-5000" y="-5000" width="10000" height="10000" fill="white" />
        <rect
          x="50%"
          y="40%"
          width="426.8"
          height="426.8"
          style={{ transform: 'translate(-213.4px, -213.4px)' }}
          fill="black"
        />
      </mask>
    </defs>
  );
}

// ── Colored tile rects from the animation state ─────────────────────────

function AnimatedTilesOverlay({
  tileColors,
  colorPalette,
}: {
  tileColors: Map<string, number>;
  colorPalette: Array<{ hex: string }>;
}) {
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

        return (
          <rect
            key={key}
            x={x}
            y={y}
            width={tileSize}
            height={tileSize}
            fill={colorId === 0 ? 'transparent' : color.hex}
          />
        );
      })}
    </>
  );
}

// ── Full-size grid ──────────────────────────────────────────────────────

function SmallTilesBackground({ tone }: { tone: GridTone }) {
  return (
    <rect
      x="-5000"
      y="-5000"
      width="10000"
      height="10000"
      fill="url(#grid-pattern)"
      mask="url(#large-tile-mask)"
      opacity={tone.opacity}
    />
  );
}
