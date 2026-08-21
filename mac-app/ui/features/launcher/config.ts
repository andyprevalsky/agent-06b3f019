/**
 * Configuration constants for the launcher feature.
 *
 * Config layer: imports own types only. Holds tuning knobs for the liquid-
 * metal shader backdrop, the pill-shaped launcher geometry, and the global
 * stylesheet that resets the Quick-Query window's chrome.
 */

/**
 * Uniforms passed to the liquid-metal fragment shader that paints the
 * launcher's backdrop. Pulled out of the component so the shader can be
 * retuned without touching render code.
 */
export const LAUNCHER_SHADER_UNIFORMS = {
  u_repetition: 0.5,
  u_softness: 0.8,
  u_shiftRed: 0.15,
  u_shiftBlue: 0.15,
  u_distortion: 0,
  u_contour: 0,
  u_angle: 90,
  u_scale: 1.5,
  u_shape: 0,
  u_offsetX: 0,
  u_offsetY: 0,
};

/**
 * Device-pixel-ratio multiplier for the shader mount. Kept at 0.5 to save
 * GPU work on high-DPI displays — the launcher is a small pill and full DPR
 * adds no perceptible quality.
 */
export const LAUNCHER_SHADER_DPR = 0.5;

/**
 * Pixel height of the launcher pill. The shader fills the inner container
 * to this size; the width comes from the component's flex layout.
 */
export const LAUNCHER_PILL_HEIGHT = 52;

/**
 * Pixel width of the launcher pill (the containing absolute-positioned box).
 */
export const LAUNCHER_PILL_WIDTH = 384;

/**
 * Electron BrowserWindow content size (must match QuickQueryController).
 */
export const LAUNCHER_WINDOW_WIDTH = 500;
export const LAUNCHER_WINDOW_HEIGHT = 100;

/**
 * Extra window height reserved for the attachment chip row when files are held.
 * Kept for tests / simple height estimates; live sizing uses content measurement.
 */
export const LAUNCHER_ATTACHMENT_AREA_HEIGHT = 56;

/** Gradient ring thickness around the inner fill (outer height = content + 2×ring). */
export const LAUNCHER_RING_PX = 2;

/** Chrome padding around the measured form content inside the inner fill. */
export const LAUNCHER_INNER_PAD_Y = 4;

/** Per-file / total size caps — mirror front-end `MAX_FILE_SIZE` / `MAX_TOTAL_ATTACHMENTS_SIZE`. */
export const LAUNCHER_MAX_FILE_SIZE = 20 * 1024 * 1024;
export const LAUNCHER_MAX_TOTAL_ATTACHMENTS_SIZE = 100 * 1024 * 1024;

/**
 * Delay in ms before focusing the input after a toggle({open:true}) event.
 * Matches the original setTimeout — gives the Electron window time to show
 * before we grab focus, avoiding a race where focus is stolen by the OS.
 */
export const LAUNCHER_FOCUS_DELAY_MS = 100;

/** Content height of the pill when attachment chips are visible (legacy helper). */
export const launcherPillHeight = (hasAttachments: boolean): number =>
  hasAttachments ? LAUNCHER_PILL_HEIGHT + LAUNCHER_ATTACHMENT_AREA_HEIGHT : LAUNCHER_PILL_HEIGHT;

/**
 * Pill outer height from measured middle-column content height.
 * Always at least the idle pill; grows with chips + multi-line text.
 * When files are held, enforce a roomier min height so short+files isn't cramped.
 */
export const launcherPillHeightFromContent = (
  contentHeight: number,
  hasAttachments = false
): number => {
  const minInner = hasAttachments
    ? LAUNCHER_PILL_HEIGHT - LAUNCHER_RING_PX * 2 + LAUNCHER_ATTACHMENT_AREA_HEIGHT
    : LAUNCHER_PILL_HEIGHT - LAUNCHER_RING_PX * 2;
  const inner = Math.max(minInner, contentHeight + LAUNCHER_INNER_PAD_Y * 2);
  return inner + LAUNCHER_RING_PX * 2;
};

/** BrowserWindow content height for the current attachment state (legacy helper). */
export const launcherWindowHeight = (hasAttachments: boolean): number =>
  hasAttachments
    ? LAUNCHER_WINDOW_HEIGHT + LAUNCHER_ATTACHMENT_AREA_HEIGHT
    : LAUNCHER_WINDOW_HEIGHT;

/** BrowserWindow content height from measured pill height (+ window chrome slack). */
export const launcherWindowHeightFromPill = (pillHeight: number): number => {
  const slack = LAUNCHER_WINDOW_HEIGHT - LAUNCHER_PILL_HEIGHT;
  return Math.max(LAUNCHER_WINDOW_HEIGHT, pillHeight + slack);
};
/**
 * Global stylesheet injected into the launcher document head.
 *
 * Overrides Tailwind's default `bg-background` and resets the window chrome
 * to a transparent pill. Kept as a string constant so the entry file can
 * install it once at module load time without owning any styling logic.
 */
export const LAUNCHER_GLOBAL_CSS = `
  html, body, #root {
    margin: 0 !important;
    padding: 0 !important;
    background: transparent !important;
    background-color: transparent !important;
    width: 100% !important;
    height: 100% !important;
    overflow: hidden !important;
  }
  body {
    background: transparent !important;
    background-color: transparent !important;
    overflow: hidden !important;
  }
  .drag-region {
    -webkit-app-region: drag;
  }
  .no-drag,
  button, input, textarea, select {
    -webkit-app-region: no-drag;
  }
  .placeholder-input::placeholder {
    color: rgba(39, 39, 37, 0.5);
  }
`;
