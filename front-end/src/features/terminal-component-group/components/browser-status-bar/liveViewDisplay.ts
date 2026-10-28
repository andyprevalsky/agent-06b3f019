/**
 * Live-view display contract (geometry / chrome crop helpers).
 *
 * Filename is intentionally `liveViewDisplay.ts`, not `liveViewFrame.ts`:
 * macOS CI is case-insensitive and the old `liveViewFrame.ts` collided with
 * the component's former `LiveViewFrame.tsx` name. The distinct names also
 * keep the Electron release build's imports unambiguous.
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
 * Kernel sessions are created at 1280x800 (no FE chrome crop). That is the
 * whole headful screen: Chrome's tab strip + toolbar fill its top 87px, so the
 * page viewport (where agent/cursor coordinates live) is 1280x713 at y=87.
 * Kernel's player also never upscales past native 1280x800 (it centers the
 * native frame in a larger iframe), so the FE renders its iframe at native
 * pixels and CSS-scales it to the clip, exactly like Steel.
 * Tilion's viewer page (`/v1/session/{id}/live-view?token=…`) streams the
 * page at the session viewport with no window chrome, so it is uncropped too.
 * Its view token expires after 1800 s (see the Tilion helpers below).
 *
 * Neither surface may resize the remote viewport to the FE pane: that
 * desyncs the fingerprint (spoofed outer/screen vs real inner).
 */

export const STEEL_LIVE_VIEW_WINDOW = { width: 1288, height: 891 } as const;
export const KERNEL_LIVE_VIEW_WINDOW = { width: 1280, height: 800 } as const;
export const LIVE_VIEW_CONTENT_VIEWPORT = { width: 1280, height: 800 } as const;
/** Matches Steel session create: 1280+8 by 800+91, and BrowserCursorOverlay. */
export const STEEL_CHROME_CROP = { x: 4, y: 91 } as const;

/**
 * Kernel headful Chrome UI above the page, in stream pixels. Measured on a live
 * 1280x800 Kernel session (2026-10-28): innerWidth 1280, innerHeight 713, and a
 * page-space mark at (x, y) painted at stream (x, y + 87).
 */
export const KERNEL_PAGE_OFFSET = { x: 0, y: 87 } as const;

/**
 * Agent statuses whose browser can never resume. OUT_OF_CREDITS and
 * COST_LIMIT_REACHED are resumable pauses, so their session may still be live.
 */
export function isFinishedAgentStatus(status: string | null | undefined): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

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
    const hostname = new URL(url).hostname.toLowerCase();
    return ['steel.dev', 'steelbrowser.com'].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/** Tilion view tokens last 1800 s from mint (Tilion API reference, section 11). */
export const TILION_LIVE_VIEW_TOKEN_TTL_MS = 1_800_000;
/**
 * Re-mint 5 minutes before expiry. The token is checked when the viewer opens
 * its stream, so a reconnect after expiry would be refused with 403.
 */
export const TILION_LIVE_VIEW_REFRESH_MS = TILION_LIVE_VIEW_TOKEN_TTL_MS - 300_000;

const TILION_LIVE_VIEW_PATH = /^\/v1\/session\/([^/]+)\/live-view$/;

/** Tilion session id for a Tilion viewer-page URL, else null. Never returns the token. */
export function tilionLiveViewSessionId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'tilion.dev' && !hostname.endsWith('.tilion.dev')) return null;
    const match = TILION_LIVE_VIEW_PATH.exec(parsed.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function isKernelLiveViewUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ['kernel.sh', 'onkernel.com'].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/**
 * Where the remote PAGE viewport sits inside the displayed 1280x800 stream.
 * Browser action and BROWSER_CURSOR coordinates are page CSS pixels; the cursor
 * overlay maps them through this rect so it lands on the action at any pane size.
 */
export function resolveLiveViewPageRect(url: string | null | undefined): LiveViewVisibleStreamRect {
  const content = LIVE_VIEW_CONTENT_VIEWPORT;
  if (url && isKernelLiveViewUrl(url)) {
    return {
      x: KERNEL_PAGE_OFFSET.x,
      y: KERNEL_PAGE_OFFSET.y,
      width: content.width - KERNEL_PAGE_OFFSET.x,
      height: content.height - KERNEL_PAGE_OFFSET.y,
    };
  }
  // Steel's chrome is cropped away and Tilion streams the page only.
  return { x: 0, y: 0, width: content.width, height: content.height };
}

/**
 * Page-space point -> fraction (0..1) of the displayed stream box. Fractions
 * are size-independent, so the overlay stays aligned through any resize, DPR
 * or letterbox without measuring the pane.
 */
export function liveViewPointFraction(
  rect: LiveViewVisibleStreamRect,
  point: { x: number; y: number },
): { x: number; y: number } {
  const content = LIVE_VIEW_CONTENT_VIEWPORT;
  return {
    x: (rect.x + point.x) / content.width,
    y: (rect.y + point.y) / content.height,
  };
}

export function isTilionLiveViewUrl(url: string): boolean {
  return tilionLiveViewSessionId(url) !== null;
}

/** The Tilion viewer URL currently shown, and when its token was adopted. */
export interface HeldTilionLiveView {
  sessionId: string;
  url: string;
  adoptedAtMs: number;
}

/**
 * Every backend live-view read mints a fresh Tilion token, so the URL string
 * changes on each focus/visibility read. Keep showing the adopted URL for the
 * same session until it is due for refresh; adopt immediately on a new session.
 */
export function nextHeldTilionLiveView(
  held: HeldTilionLiveView | null,
  boundUrl: string | null,
  nowMs: number,
): HeldTilionLiveView | null {
  const sessionId = boundUrl === null ? null : tilionLiveViewSessionId(boundUrl);
  if (boundUrl === null || sessionId === null) return null;
  if (
    held !== null &&
    held.sessionId === sessionId &&
    nowMs - held.adoptedAtMs < TILION_LIVE_VIEW_REFRESH_MS
  ) {
    return held;
  }
  return { sessionId, url: boundUrl, adoptedAtMs: nowMs };
}

/** URL to present: the held Tilion URL for the bound session, else the bound URL. */
export function presentHeldLiveViewUrl(
  held: HeldTilionLiveView | null,
  boundUrl: string | null,
): string | null {
  if (boundUrl === null || held === null) return boundUrl;
  return tilionLiveViewSessionId(boundUrl) === held.sessionId ? held.url : boundUrl;
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

/** Kernel iframe at native 1280x800, scaled to the clip (its player never upscales). */
export function kernelLiveViewScaledStyle(clipWidth: number): {
  position: 'absolute';
  width: string;
  height: string;
  left: string;
  top: string;
  border: string;
  transformOrigin: 'top left';
  transform: string;
} {
  return {
    position: 'absolute',
    width: `${KERNEL_LIVE_VIEW_WINDOW.width}px`,
    height: `${KERNEL_LIVE_VIEW_WINDOW.height}px`,
    left: '0',
    top: '0',
    border: '0',
    transformOrigin: 'top left',
    transform: `scale(${clipWidth / KERNEL_LIVE_VIEW_WINDOW.width})`,
  };
}

/** Pre-measure Kernel fallback; 100cqw is the clip box. */
export function kernelLiveViewIframeStyle(): ReturnType<typeof kernelLiveViewScaledStyle> {
  return {
    ...kernelLiveViewScaledStyle(KERNEL_LIVE_VIEW_WINDOW.width),
    transform: `scale(calc(100cqw / ${KERNEL_LIVE_VIEW_WINDOW.width}))`,
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
