/**
 * Static tile background — mirrors the tuned 143×143 grid pattern from the
 * main terminal page (front-end/src/features/terminal/components/BackgroundPattern.tsx).
 *
 * The pattern is rendered identically; the only change is that the pattern's
 * (x, y) origin is computed each resize so a tile corner lands at the
 * viewport center. (The terminal version aligns to its center large tile via
 * `usePatternOffset`; we have no large tile, so we align to viewport center
 * directly — same `% 143` modulo trick.)
 */

import { useEffect, useState } from 'react';

const SMALL_DIAMOND_PATH = 'M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z';

const computeOffset = (): { x: number; y: number } => {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  return {
    x: ((cx % 143) + 143) % 143,
    y: ((cy % 143) + 143) % 143,
  };
};

const BackgroundTiles = (): JSX.Element => {
  const [offset, setOffset] = useState<{ x: number; y: number }>(() => computeOffset());

  useEffect(() => {
    const update = (): void => setOffset(computeOffset());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none z-0"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="onboarding-grid-pattern"
          x={offset.x}
          y={offset.y}
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
            stroke="rgb(229, 231, 235)"
            strokeWidth="1"
            className="dark:stroke-gray-800"
          />
          <path
            d={SMALL_DIAMOND_PATH}
            transform="translate(0 0)"
            fill="rgb(229, 231, 235)"
            className="dark:fill-gray-800"
          />
          <path
            d={SMALL_DIAMOND_PATH}
            transform="translate(143 0)"
            fill="rgb(229, 231, 235)"
            className="dark:fill-gray-800"
          />
          <path
            d={SMALL_DIAMOND_PATH}
            transform="translate(0 143)"
            fill="rgb(229, 231, 235)"
            className="dark:fill-gray-800"
          />
          <path
            d={SMALL_DIAMOND_PATH}
            transform="translate(143 143)"
            fill="rgb(229, 231, 235)"
            className="dark:fill-gray-800"
          />
        </pattern>
      </defs>
      <rect x="0" y="0" width="100%" height="100%" fill="url(#onboarding-grid-pattern)" />
    </svg>
  );
};

export default BackgroundTiles;
