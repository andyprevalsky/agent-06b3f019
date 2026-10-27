/**
 * STATE MACHINE: LargeTileDecorations
 *
 * STATIC: the main (large) tile border, its two sparkle circles + rose-gradient
 *         diamonds (top corners) and two small diamonds (bottom corners), drawn
 *         inside BackgroundPattern's grid svg. No state; the GridTone prop picks
 *         STOCK (light, unchanged markup) or ROSE_DARK (neutral silver, one low
 *         opacity). The rose-gradient diamonds never change.
 */

import type { GridTone } from './backgroundGridTone';

const DIAMOND_PATH =
  'M 0.5,-12 L 0.5,-6 C 0.5,-4 2,-2 4,-1 L 6,-0.5 L 12,-0.5 L 12,0.5 L 6,0.5 L 4,1 C 2,2 0.5,4 0.5,6 L 0.5,12 L -0.5,12 L -0.5,6 C -0.5,4 -2,2 -4,1 L -6,0.5 L -12,0.5 L -12,-0.5 L -6,-0.5 L -4,-1 C -2,-2 -0.5,-4 -0.5,-6 L -0.5,-12 Z';
const SMALL_DIAMOND_PATH = 'M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z';

export function LargeTileBorder({ tone }: { tone: GridTone }) {
  return (
    <rect
      x="50%"
      y="40%"
      width="429"
      height="429"
      style={{ transform: 'translate(-214.5px, -214.5px)' }}
      fill="none"
      stroke={tone.color}
      strokeWidth="1"
      className={tone.strokeClassName}
      opacity={tone.opacity}
    />
  );
}

export function LargeTileCorners({ tone }: { tone: GridTone }) {
  return (
    <>
      <circle
        cx="0"
        cy="0"
        r="25"
        fill="none"
        stroke={tone.color}
        strokeWidth="1"
        className={tone.strokeClassName}
        opacity={tone.opacity}
        style={{ transform: 'translate(calc(50% - 214.5px), calc(40% - 214.5px))' }}
      />
      <path
        d={DIAMOND_PATH}
        fill="url(#rose-gradient)"
        style={{ transform: 'translate(calc(50% - 214.5px), calc(40% - 214.5px))' }}
      />
      <circle
        cx="0"
        cy="0"
        r="25"
        fill="none"
        stroke={tone.color}
        strokeWidth="1"
        className={tone.strokeClassName}
        opacity={tone.opacity}
        style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }}
      />
      <path
        d={DIAMOND_PATH}
        fill="url(#rose-gradient)"
        style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }}
      />
      <path
        d={SMALL_DIAMOND_PATH}
        fill={tone.color}
        className={tone.fillClassName}
        opacity={tone.opacity}
        style={{ transform: 'translate(calc(50% - 214.5px), calc(40% + 214.5px))' }}
      />
      <path
        d={SMALL_DIAMOND_PATH}
        fill={tone.color}
        className={tone.fillClassName}
        opacity={tone.opacity}
        style={{ transform: 'translate(calc(50% + 214.5px), calc(40% + 214.5px))' }}
      />
    </>
  );
}
