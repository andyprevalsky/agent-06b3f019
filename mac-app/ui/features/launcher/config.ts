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
 * Delay in ms before focusing the input after a toggle({open:true}) event.
 * Matches the original setTimeout — gives the Electron window time to show
 * before we grab focus, avoiding a race where focus is stolen by the OS.
 */
export const LAUNCHER_FOCUS_DELAY_MS = 100;

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
  button, input, textarea, select {
    -webkit-app-region: no-drag;
  }
  .placeholder-input::placeholder {
    color: rgba(39, 39, 37, 0.5);
  }
`;
