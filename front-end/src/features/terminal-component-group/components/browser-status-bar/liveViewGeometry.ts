/**
 * Live-view display contract.
 *
 * User FE pane (arbitrary leftover size)
 *   -> letterbox the CONTENT viewport (1280x800)
 *     -> clip box (overflow hidden)
 *       -> iframe (Steel: native 1288x891 canvas, CSS-scaled so the
 *          1280x800 page including the right-edge cart fits, then
 *          translated by (-4, -91) * scale)
 *         -> Steel/Kernel player
 *           -> remote browser (UNCHANGED session size — antibot)
 *
 * Steel headful debug streams the full computer window (1288x891):
 * 1280x800 content + 4px side borders + 91px toolbar. Showing that window
 * in the FE makes page content look off-center / hanging outside the window.
 * Kernel sessions are created at 1280x800 (no FE chrome crop).
 *
 * Neither surface may resize the remote viewport to the FE pane: that
 * desyncs the fingerprint (spoofed outer/screen vs real inner).
 */

export const STEEL_LIVE_VIEW_WINDOW = { width: 1288, height: 891 } as const;
export const KERNEL_LIVE_VIEW_WINDOW = { width: 1280, height: 800 } as const;
export const LIVE_VIEW_CONTENT_VIEWPORT = { width: 1280, height: 800 } as const;
/** Matches Steel session create: 1280+8 by 800+91, and BrowserCursorOverlay. */
export const STEEL_CHROME_CROP = { x: 4, y: 91 } as const;

export interface LiveViewSize {
  width: number;
  height: number;
}

export interface LiveViewLetterbox {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface LiveViewChromeCrop {
  window: LiveViewSize;
  content: LiveViewSize;
  offsetX: number;
  offsetY: number;
}

export interface LiveViewVisibleStreamRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isSteelLiveViewUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes('steel');
  } catch {
    return url.toLowerCase().includes('steel');
  }
}

/** Remote player canvas size — Steel includes window chrome. */
export function resolveLiveViewWindowSize(url: string): LiveViewSize {
  return isSteelLiveViewUrl(url)
    ? { width: STEEL_LIVE_VIEW_WINDOW.width, height: STEEL_LIVE_VIEW_WINDOW.height }
    : { width: KERNEL_LIVE_VIEW_WINDOW.width, height: KERNEL_LIVE_VIEW_WINDOW.height };
}

/** What the user should see: the page content viewport, never window chrome. */
export function resolveLiveViewDisplaySize(_url: string): LiveViewSize {
  return {
    width: LIVE_VIEW_CONTENT_VIEWPORT.width,
    height: LIVE_VIEW_CONTENT_VIEWPORT.height,
  };
}

/** @deprecated use resolveLiveViewDisplaySize — kept as the FE frame size. */
export function resolveLiveViewStreamSize(url: string): LiveViewSize {
  return resolveLiveViewDisplaySize(url);
}

export function resolveLiveViewChromeCrop(url: string): LiveViewChromeCrop | null {
  if (!isSteelLiveViewUrl(url)) return null;
  return {
    window: {
      width: STEEL_LIVE_VIEW_WINDOW.width,
      height: STEEL_LIVE_VIEW_WINDOW.height,
    },
    content: {
      width: LIVE_VIEW_CONTENT_VIEWPORT.width,
      height: LIVE_VIEW_CONTENT_VIEWPORT.height,
    },
    offsetX: STEEL_CHROME_CROP.x,
    offsetY: STEEL_CHROME_CROP.y,
  };
}

/** Stream pixels that land inside the FE clip after the Steel chrome crop. */
export function visibleSteelStreamRect(): LiveViewVisibleStreamRect {
  return {
    x: STEEL_CHROME_CROP.x,
    y: STEEL_CHROME_CROP.y,
    width: LIVE_VIEW_CONTENT_VIEWPORT.width,
    height: LIVE_VIEW_CONTENT_VIEWPORT.height,
  };
}

/**
 * Steel's player paints a native 1288x891 computer window. Percentage-sizing
 * the iframe does not shrink that canvas, so a leftover FE pane (~1100px)
 * clips the right of the page (Amazon cart). Match the thumbnail: keep the
 * iframe at native window pixels and CSS-scale it so the 1280 content box
 * fills the clip, then translate by the chrome origin.
 *
 * 100cqw/cqh are the clip box (`live-view-stream` is a size container).
 */
export function steelLiveViewIframeCropStyle(): {
  position: 'absolute';
  width: string;
  height: string;
  left: string;
  top: string;
  border: string;
  transformOrigin: 'top left';
  transform: string;
} {
  const windowSize = STEEL_LIVE_VIEW_WINDOW;
  const content = LIVE_VIEW_CONTENT_VIEWPORT;
  return {
    position: 'absolute',
    width: `${windowSize.width}px`,
    height: `${windowSize.height}px`,
    left: '0',
    top: '0',
    border: '0',
    transformOrigin: 'top left',
    transform: `translate(calc(${-STEEL_CHROME_CROP.x} * 100cqw / ${content.width}), calc(${-STEEL_CHROME_CROP.y} * 100cqh / ${content.height})) scale(calc(100cqw / ${content.width}))`,
  };
}

/** Pixel crop once the clip box is measured. Prefer this over cqw — Steel's native canvas ignores percentage iframe sizing. */
export function steelLiveViewScaledCropStyle(clipWidth: number): {
  position: 'absolute';
  width: string;
  height: string;
  left: string;
  top: string;
  border: string;
  transformOrigin: 'top left';
  transform: string;
} {
  const scale = clipWidth / LIVE_VIEW_CONTENT_VIEWPORT.width;
  return {
    position: 'absolute',
    width: `${STEEL_LIVE_VIEW_WINDOW.width}px`,
    height: `${STEEL_LIVE_VIEW_WINDOW.height}px`,
    left: '0',
    top: '0',
    border: '0',
    transformOrigin: 'top left',
    transform: `translate(${-STEEL_CHROME_CROP.x * scale}px, ${-STEEL_CHROME_CROP.y * scale}px) scale(${scale})`,
  };
}

export function computeLiveViewLetterbox(
  paneWidth: number,
  paneHeight: number,
  streamWidth: number,
  streamHeight: number,
): LiveViewLetterbox {
  if (streamWidth <= 0 || streamHeight <= 0 || paneWidth < 0 || paneHeight < 0) {
    throw new Error('Live-view letterbox requires positive pane and stream dimensions');
  }
  if (paneWidth === 0 || paneHeight === 0) {
    return { width: 0, height: 0, offsetX: 0, offsetY: 0, scale: 0 };
  }
  const scale = Math.min(paneWidth / streamWidth, paneHeight / streamHeight);
  const width = Math.min(paneWidth, streamWidth * scale);
  const height = Math.min(paneHeight, streamHeight * scale);
  return {
    width,
    height,
    offsetX: (paneWidth - width) / 2,
    offsetY: (paneHeight - height) / 2,
    scale,
  };
}

export function computeCroppedLiveViewIframe(
  clip: LiveViewLetterbox,
  crop: LiveViewChromeCrop,
): { width: number; height: number; x: number; y: number; scale: number } {
  const scale = clip.width / crop.content.width;
  return {
    width: crop.window.width,
    height: crop.window.height,
    x: clip.offsetX - crop.offsetX * scale,
    y: clip.offsetY - crop.offsetY * scale,
    scale,
  };
}

/** True when the letterboxed stream sits entirely inside the pane (no overflow). */
export function liveViewStreamFitsPane(
  paneWidth: number,
  paneHeight: number,
  streamWidth: number,
  streamHeight: number,
): boolean {
  const box = computeLiveViewLetterbox(paneWidth, paneHeight, streamWidth, streamHeight);
  const epsilon = 1e-6;
  return (
    box.width <= paneWidth + epsilon &&
    box.height <= paneHeight + epsilon &&
    box.offsetX >= -epsilon &&
    box.offsetY >= -epsilon &&
    box.offsetX + box.width <= paneWidth + epsilon &&
    box.offsetY + box.height <= paneHeight + epsilon
  );
}
