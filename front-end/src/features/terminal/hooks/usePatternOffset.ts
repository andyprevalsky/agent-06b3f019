/**
 * Terminal feature — pattern offset hook.
 *
 * Calculates and updates the SVG grid pattern offset
 * so that grid lines align with the large tile position.
 */

import { useState, useEffect, useMemo } from 'react';

import { colorPalette, frameSequence, getTileColorsForFrame } from '@/lib/tileAnimation';

export function usePatternOffset(currentFrame: number) {
  const [patternOffset, setPatternOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const updatePatternOffset = () => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const tileX = viewportWidth * 0.5 - 214.5;
      const tileY = viewportHeight * 0.4 - 214.5;

      const x = ((tileX % 143) + 143) % 143;
      const y = ((tileY % 143) + 143) % 143;

      setPatternOffset({ x, y });
    };

    updatePatternOffset();
    window.addEventListener('resize', updatePatternOffset);
    return () => window.removeEventListener('resize', updatePatternOffset);
  }, []);

  const tileColors = useMemo(() => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const frameName = frameSequence[currentFrame];
    return getTileColorsForFrame(frameName, viewportWidth, viewportHeight, 143, 429);
  }, [currentFrame]);

  return { patternOffset, tileColors, colorPalette };
}
