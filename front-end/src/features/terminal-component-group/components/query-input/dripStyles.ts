/**
 * Helpers that compute inline drip-backdrop CSS from the `DripStyles` object.
 *
 * Isolated so `QueryInput.tsx` stays light on inline style ternaries.
 *
 * THEME: `roseDark` (Rose Desktop dark mode, useRoseTheme().isDark) swaps the
 * translucent white drip for the mock's solid dark surface (#2f2f2c, 9% white
 * border, deep shadow) and drops the white marble layer. Light mode (and every
 * stock account, which never goes dark) takes the original branch unchanged.
 */

import type { CSSProperties } from 'react';
import type { DripStyles } from './types';

/** Rose dark query box (mock panels/dark.js: div.rounded-xl:has(textarea)). */
export const ROSE_DARK_QUERY_SURFACE = {
  backgroundColor: '#2f2f2c',
  borderColor: 'rgba(255, 255, 255, 0.09)',
  boxShadow: '0 10px 40px rgba(0, 0, 0, 0.35)',
} as const;

export function buildDripContainerStyle(
  dripStyles: DripStyles,
  drippiness: number,
  isDragOver: boolean,
  roseDark = false,
): CSSProperties {
  if (roseDark) {
    return {
      backgroundColor: ROSE_DARK_QUERY_SURFACE.backgroundColor,
      // Drag-over keeps the stock primary border (class), like light mode.
      borderColor: isDragOver ? undefined : ROSE_DARK_QUERY_SURFACE.borderColor,
      boxShadow: ROSE_DARK_QUERY_SURFACE.boxShadow,
    };
  }
  const filter =
    drippiness > 0
      ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
      : undefined;
  return {
    backdropFilter: filter,
    WebkitBackdropFilter: filter,
    backgroundColor:
      dripStyles.backgroundColorsScalar > 0
        ? `rgba(255, 255, 255, ${dripStyles.bgOpacity})`
        : 'transparent',
    borderColor: !isDragOver && dripStyles.borderColorScalar > 0 ? dripStyles.borderRgb : undefined,
    boxShadow:
      dripStyles.shadowIntensity > 0
        ? `0 8px 32px rgba(0, 0, 0, ${dripStyles.shadowIntensity}), 0 0 ${dripStyles.glow}px rgba(126, 87, 194, ${dripStyles.glowOpacity}), inset 0 1px 1px rgba(255,255,255,${dripStyles.bgOpacity * 0.5})`
        : undefined,
  };
}

/** The whitish marble layer; never drawn on the Rose dark surface. */
export function showsMarbleBackground(dripStyles: DripStyles, roseDark = false): boolean {
  return !roseDark && dripStyles.backgroundColorsScalar > 0;
}

export function buildMarbleBackgroundStyle(dripStyles: DripStyles): CSSProperties {
  const s = dripStyles.backgroundColorsScalar;
  return {
    background: `radial-gradient(circle at 15% 30%, rgba(255, 248, 245, ${0.7 * s}) 0%, transparent 45%),
                 radial-gradient(circle at 85% 70%, rgba(248, 245, 255, ${0.6 * s}) 0%, transparent 45%),
                 radial-gradient(circle at 50% 50%, rgba(255, 250, 255, ${0.5 * s}) 0%, transparent 55%),
                 radial-gradient(circle at 30% 80%, rgba(252, 248, 255, ${0.55 * s}) 0%, transparent 50%)`,
    opacity: 0.25 + s * 0.5,
    zIndex: -1,
  };
}
