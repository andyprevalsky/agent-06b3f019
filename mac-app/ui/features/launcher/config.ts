/**
 * Configuration constants for the launcher feature.
 *
 * Config layer: imports own types only. Holds the pill-shaped launcher
 * geometry and the global stylesheet that resets the Quick-Query window's
 * chrome and defines its light/dark palette. The liquid-metal ring lives in
 * `ui/shared/liquid-metal` (shared with the update chip).
 */

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
    color: var(--launcher-placeholder);
  }
  :root {
    --launcher-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1);
    --launcher-fill: #f5f5f5;
    --launcher-fill-shadow: none;
    --launcher-text: #272725;
    --launcher-muted: rgba(39, 39, 37, 0.55);
    --launcher-placeholder: rgba(39, 39, 37, 0.5);
    --launcher-chip-bg: rgba(39, 39, 37, 0.08);
    --launcher-error: #b91c1c;
    --launcher-drop-bg: rgba(245, 245, 245, 0.92);
    --launcher-drop-text: #1d4ed8;
    --launcher-submit-border: 1px solid rgba(255, 255, 255, 0.85);
    --launcher-submit-bg: linear-gradient(180deg, #f4f4f4 0%, #cfcfcf 45%, #9f9f9f 100%);
    --launcher-submit-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), inset 0 1px 2px rgba(255, 255, 255, 0.8);
    --launcher-submit-icon: #ffffff;
  }
  /* Dark: html.dark mirrored from the main window (ui/shared/theme-sync).
     Palette matches the main query box's dark mode; the send button is its
     black-glass face inside the same liquid-metal gradient ring. */
  html.dark {
    color-scheme: dark;
    --launcher-shadow: 0 6px 18px rgba(0, 0, 0, 0.45), 0 2px 4px rgba(0, 0, 0, 0.3);
    --launcher-fill: #262624;
    --launcher-fill-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    --launcher-text: #f2f2ef;
    --launcher-muted: rgba(236, 236, 234, 0.6);
    --launcher-placeholder: #8c8c86;
    --launcher-chip-bg: rgba(255, 255, 255, 0.08);
    --launcher-error: #f87171;
    --launcher-drop-bg: rgba(38, 38, 36, 0.94);
    --launcher-drop-text: #8fcfff;
    --launcher-submit-border: 2px solid transparent;
    --launcher-submit-bg:
      radial-gradient(circle at 50% 115%, rgba(58, 58, 62, 0.95), rgba(6, 6, 8, 1) 62%) padding-box,
      linear-gradient(180deg, #f4f4f4 0%, #cfcfcf 45%, #9f9f9f 100%) border-box;
    --launcher-submit-shadow: 0 4px 12px rgba(0, 0, 0, 0.4), inset 0 1px 2px rgba(255, 255, 255, 0.35);
    --launcher-submit-icon: #fbfbf9;
  }
`;
