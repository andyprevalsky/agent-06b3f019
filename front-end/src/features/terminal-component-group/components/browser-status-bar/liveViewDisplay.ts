/**
 * Live-view display contract (geometry / chrome crop helpers).
 *
 * Filename is intentionally `liveViewDisplay.ts`, not `liveViewFrame.ts`:
 * macOS CI is case-insensitive and the old `liveViewFrame.ts` collided with
 * the component's former `LiveViewFrame.tsx` name. The distinct names also
 * keep the Electron release build's imports unambiguous.
 *
 * User FE pane (arbitrary leftover size)
 *   -> letterbox the provider DISPLAY rect (LIVE_VIEW_GEOMETRY[provider])
 *     -> clip box (overflow hidden)
 *       -> iframe (Steel/Kernel: native window pixels, CSS-scaled to the
 *          clip and, for Steel, translated by -display.origin * scale;
 *          Tilion: ?embed=1 viewer filling the clip)
 *         -> provider player
 *           -> remote browser (UNCHANGED session size — antibot)
 *
 * PER-PROVIDER GEOMETRY (window px; measured on live sessions 2026-10-28 by
 * painting marks at known page coordinates and locating them in the stream):
 *   Kernel  window 1280x800 = the whole headful screen. Chrome's tab strip +
 *           toolbar fill the top 87px: page viewport 1280x713 at (0,87).
 *           The player centers the native frame and never upscales, so the
 *           FE renders the iframe at native pixels and CSS-scales it. Display
 *           keeps the Chrome UI (whole window).
 *   Steel   window 1288x891 = 4px side/bottom borders + 87px chrome. Page
 *           viewport 1280x800 at (4,87); the player contain-fits the window.
 *           Display crops to the page (no window chrome in the FE).
 *   Tilion  ?embed=1 viewer streams only the page viewport (no chrome) as an
 *           object-fit:contain image anchored TOP-LEFT. The page viewport is
 *           1366x625 CSS px on every persona sampled (5 sessions; spoofed
 *           screens 1366x768..1920x1080, DPR 1..1.75), so the aspect is fixed.
 *           Without embed=1 it adds its own bar/padding, so always embed.
 *           Its view token expires after 1800 s (see the Tilion helpers below).
 * Agent action / BROWSER_CURSOR coordinates are page CSS px. The cursor maps
 * them through resolveLiveViewPageRect into the display box.
 *
 * Neither surface may resize the remote viewport to the FE pane: that
 * desyncs the fingerprint (spoofed outer/screen vs real inner).
 */

export const STEEL_LIVE_VIEW_WINDOW = { width: 1288, height: 891 } as const;
export const KERNEL_LIVE_VIEW_WINDOW = { width: 1280, height: 800 } as const;
export const LIVE_VIEW_CONTENT_VIEWPORT = { width: 1280, height: 800 } as const;
/**
 * Steel page origin inside its 1288x891 window: 4px left border, 87px chrome
 * (the remaining 4px is the bottom border, not toolbar). Measured 2026-10-28.
 */
export const STEEL_CHROME_CROP = { x: 4, y: 87 } as const;

/**
 * Kernel headful Chrome UI above the page, in stream pixels. Measured on a live
 * 1280x800 Kernel session (2026-10-28): innerWidth 1280, innerHeight 713, and a
 * page-space mark at (x, y) painted at stream (x, y + 87).
 */
export const KERNEL_PAGE_OFFSET = { x: 0, y: 87 } as const;

/**
 * Tilion page viewport = its stream (CSS px). Fixed across device personas: the
 * spoofed device.screen/DPR vary per session but innerWidth/innerHeight did not.
 */
export const TILION_LIVE_VIEW_PAGE = { width: 1366, height: 625 } as const;

export type LiveViewProvider = 'kernel' | 'steel' | 'tilion' | 'other';

export interface LiveViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** window: frame the player paints; display: part the FE shows; page: page viewport. */
export interface LiveViewGeometry {
  window: LiveViewRect;
  display: LiveViewRect;
  page: LiveViewRect;
}

const full = (width: number, height: number): LiveViewRect => ({ x: 0, y: 0, width, height });

export const LIVE_VIEW_GEOMETRY: Record<LiveViewProvider, LiveViewGeometry> = {
  kernel: {
    window: full(1280, 800),
    display: full(1280, 800),
    page: { x: KERNEL_PAGE_OFFSET.x, y: KERNEL_PAGE_OFFSET.y, width: 1280, height: 713 },
  },
  steel: {
    window: full(1288, 891),
    display: { x: STEEL_CHROME_CROP.x, y: STEEL_CHROME_CROP.y, width: 1280, height: 800 },
    page: { x: STEEL_CHROME_CROP.x, y: STEEL_CHROME_CROP.y, width: 1280, height: 800 },
  },
  tilion: {
    window: full(TILION_LIVE_VIEW_PAGE.width, TILION_LIVE_VIEW_PAGE.height),
    display: full(TILION_LIVE_VIEW_PAGE.width, TILION_LIVE_VIEW_PAGE.height),
    page: full(TILION_LIVE_VIEW_PAGE.width, TILION_LIVE_VIEW_PAGE.height),
  },
  other: {
    window: full(1280, 800),
    display: full(1280, 800),
    page: full(1280, 800),
  },
};

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

export function resolveLiveViewProvider(url: string | null | undefined): LiveViewProvider {
  if (!url) return 'other';
  if (isSteelLiveViewUrl(url)) return 'steel';
  if (isKernelLiveViewUrl(url)) return 'kernel';
  if (isTilionLiveViewUrl(url)) return 'tilion';
  return 'other';
}

export function resolveLiveViewGeometry(url: string | null | undefined): LiveViewGeometry {
  return LIVE_VIEW_GEOMETRY[resolveLiveViewProvider(url)];
}

/**
 * Where the remote PAGE viewport sits inside the displayed box (display px).
 * Browser action and BROWSER_CURSOR coordinates are page CSS pixels; the cursor
 * overlay maps them through this rect so it lands on the action at any pane size.
 */
export function resolveLiveViewPageRect(url: string | null | undefined): LiveViewRect {
  const { display, page } = resolveLiveViewGeometry(url);
  return { x: page.x - display.x, y: page.y - display.y, width: page.width, height: page.height };
}

/**
 * Page-space point -> fraction (0..1) of the displayed box. Fractions are
 * size-independent, so the overlay stays aligned through any resize, DPR or
 * letterbox without measuring the pane.
 */
export function liveViewPointFraction(
  url: string | null | undefined,
  point: { x: number; y: number },
): { x: number; y: number } {
  const { display } = resolveLiveViewGeometry(url);
  const rect = resolveLiveViewPageRect(url);
  return {
    x: (rect.x + point.x) / display.width,
    y: (rect.y + point.y) / display.height,
  };
}

/**
 * The URL the FE iframe loads. Tilion's viewer adds its own bar and padding
 * unless embedded; embed=1 streams only the page, so the geometry above holds.
 */
export function presentLiveViewIframeUrl(url: string): string {
  if (!isTilionLiveViewUrl(url)) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('embed', '1');
  return parsed.toString();
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
  const frame = resolveLiveViewGeometry(url).window;
  return { width: frame.width, height: frame.height };
}

/** What the FE box shows (its aspect ratio): the provider display rect. */
export function resolveLiveViewDisplaySize(url: string): LiveViewSize {
  const { display } = resolveLiveViewGeometry(url);
  return { width: display.width, height: display.height };
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
