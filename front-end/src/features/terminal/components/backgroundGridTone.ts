/**
 * Grid tones for BackgroundPattern + LargeTileDecorations (see BackgroundPattern's
 * THEME section): STOCK for light (unchanged markup), ROSE_DARK for Rose dark mode.
 */

/** Colour + classes of the grid lines, main tile border, circles and small diamonds. */
export interface GridTone {
  color: string;
  strokeClassName?: string;
  fillClassName?: string;
  /** Layer opacity; undefined renders no attribute. */
  opacity?: number;
}

/** Stock (light) markup, unchanged. Its dark: classes stay inert: Rose dark renders ROSE_DARK_GRID_TONE. */
export const STOCK_GRID_TONE: GridTone = {
  color: 'rgb(229, 231, 235)',
  strokeClassName: 'dark:stroke-gray-800',
  fillClassName: 'dark:fill-gray-800',
};

/** Rose dark: neutral silver (never the bluish gray-800), all at one low brightness. */
export const ROSE_DARK_GRID_TONE: GridTone = {
  color: '#d6d6d2',
  opacity: 0.14,
};

/** Rose dark: energy pill streaks dimmed to this group opacity. */
export const ROSE_DARK_ENERGY_OPACITY = 0.14;
