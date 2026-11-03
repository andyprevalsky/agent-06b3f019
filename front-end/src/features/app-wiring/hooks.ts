/**
 * App bootstrap side-effects: dev logging, analytics, viewport height.
 * Called once from main.tsx at app startup.
 */

import { sessionReplayPlugin } from '@amplitude/plugin-session-replay-browser';

import * as analytics from '@/lib/analytics';

import { sendDevLog } from './api';
import {
  AMPLITUDE_API_KEY,
  SESSION_REPLAY_SAMPLE_RATE,
  IS_DEV,
  VH_REMEASURE_DELAY_MS,
  VIEWPORT_SCALE_DESIGN_HEIGHT,
  VIEWPORT_SCALE_DESIGN_WIDTH,
  VIEWPORT_SCALE_MIN,
  VIEWPORT_SCALE_MIN_WIDTH,
} from './config';

/**
 * Logs the current app mode (development/production) at startup.
 * Uses a wrapped console.warn so domain callers stay clean of console.log.
 */
export function logStartupMode(): void {
  console.warn(`[Frontend] Mode: ${IS_DEV ? 'DEVELOPMENT' : 'PRODUCTION'}`);
}

/** Patches console.log/warn/error to forward logs to the backend in dev mode. */
export function initDevLogging(): void {
  if (!IS_DEV) return;

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = Reflect.get(console, level) as (...args: unknown[]) => void;
    Reflect.set(console, level, (...args: unknown[]) => {
      original.apply(console, args);
      sendDevLog(level, args);
    });
  }
}

/** Initializes Amplitude analytics with session replay. */
export function initAmplitude(): void {
  analytics.addPlugin(sessionReplayPlugin({ sampleRate: SESSION_REPLAY_SAMPLE_RATE }));
  analytics.init(AMPLITUDE_API_KEY, {
    autocapture: {
      attribution: true,
      fileDownloads: true,
      formInteractions: true,
      pageViews: true,
      sessions: true,
      pageUrlEnrichment: true,
      networkTracking: true,
      webVitals: true,
      frustrationInteractions: true,
      elementInteractions: { viewportContentUpdated: { enabled: true } },
    },
    transport: { type: 'fetch', enableKeepalive: true },
  });
}

/** Visual-viewport shrink beyond this is the on-screen keyboard, not iOS's
 * short standalone layout viewport (~status-bar inset) or a toolbar. */
const KEYBOARD_MIN_HEIGHT_PX = 150;

/**
 * iOS: pins the app shell (`--app-height` / `--app-top`, read by
 * TerminalContent) to what is actually visible.
 *   keyboard open  -> the visual viewport (iOS shrinks AND pans it), so the
 *                     bottom-anchored query box sits flush on the keyboard
 *   keyboard closed, installed PWA -> the full screen; iOS reports a layout
 *                     viewport short by the status-bar inset, which left a
 *                     gap under the query box with no browser toolbar there
 *   keyboard closed, Safari tab    -> the visual viewport (toolbar excluded)
 * Pinch zoom also shrinks the visual viewport; it is ignored.
 */
function setAppShellGeometry(vv: VisualViewport): void {
  const standalone =
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true;
  const landscape = window.innerWidth > window.innerHeight;
  const screenHeight = landscape
    ? Math.min(window.screen.width, window.screen.height)
    : Math.max(window.screen.width, window.screen.height);
  const fullHeight = standalone ? Math.max(screenHeight, window.innerHeight) : window.innerHeight;
  const zoomed = Math.abs((vv.scale ?? 1) - 1) > 0.01;
  const keyboardOpen = !zoomed && fullHeight - vv.height > KEYBOARD_MIN_HEIGHT_PX;
  const height = keyboardOpen ? vv.height : zoomed || standalone ? fullHeight : vv.height;
  const top = keyboardOpen ? (vv.offsetTop ?? 0) : 0;
  const root = document.documentElement.style;
  root.setProperty('--app-height', `${height}px`);
  root.setProperty('--app-top', `${top}px`);
}

/** Sets the `--vh` CSS custom property and installs resize/orientation listeners. */
export function initViewportHeight(): void {
  const setVH = () => {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
  };

  setVH();

  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => {
    setTimeout(setVH, VH_REMEASURE_DELAY_MS);
  });

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  if (isIOS && window.visualViewport) {
    const updateVH = () => {
      const vh = window.visualViewport!.height * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
      setAppShellGeometry(window.visualViewport!);
    };
    setAppShellGeometry(window.visualViewport);
    window.visualViewport.addEventListener('resize', updateVH);
    window.visualViewport.addEventListener('scroll', updateVH);
  }

  if (isIOS) {
    const delayedSetVH = () => setTimeout(setVH, VH_REMEASURE_DELAY_MS);
    window.addEventListener('focus', delayedSetVH);
    window.addEventListener('blur', delayedSetVH);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) delayedSetVH();
    });
  }
}

function clampViewportScale(scale: number): number {
  return Math.min(1, Math.max(VIEWPORT_SCALE_MIN, scale));
}

export function computeViewportScale(width: number, height: number): number {
  if (width < VIEWPORT_SCALE_MIN_WIDTH) return 1;

  const widthScale = width / VIEWPORT_SCALE_DESIGN_WIDTH;
  const heightScale = height / VIEWPORT_SCALE_DESIGN_HEIGHT;
  return Number(clampViewportScale(Math.min(widthScale, heightScale)).toFixed(3));
}

/** Scales rem-based UI for compact desktop windows without changing viewport dimensions. */
export function initViewportScale(): void {
  const setViewportScale = () => {
    const scale = computeViewportScale(window.innerWidth, window.innerHeight);
    document.documentElement.style.setProperty('--app-rem-scale', String(scale));
  };

  setViewportScale();

  window.addEventListener('resize', setViewportScale);
  window.addEventListener('orientationchange', () => {
    setTimeout(setViewportScale, VH_REMEASURE_DELAY_MS);
  });
}
