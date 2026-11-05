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

/** A shell height change this large is a keyboard opening/closing (or iOS
 * leaving the viewport short), not toolbar or scroll jitter. */
const VIEWPORT_REPORT_MIN_CHANGE_PX = 100;
let reportedShellHeight: number | null = null;

/** Records what iOS reports at each keyboard transition, so the next
 * on-device layout bug arrives with the real viewport numbers. */
function reportShellGeometry(height: number, top: number, vv: VisualViewport): void {
  if (
    reportedShellHeight !== null &&
    Math.abs(height - reportedShellHeight) < VIEWPORT_REPORT_MIN_CHANGE_PX
  ) {
    return;
  }
  reportedShellHeight = height;
  analytics.track('iOS Viewport Geometry', {
    shell_height: height,
    shell_top: top,
    inner_height: window.innerHeight,
    client_height: document.documentElement.clientHeight,
    visual_height: vv.height,
    visual_offset_top: vv.offsetTop,
    visual_scale: vv.scale,
    screen_height: window.screen.height,
    standalone:
      (navigator as { standalone?: boolean }).standalone === true ||
      window.matchMedia?.('(display-mode: standalone)').matches === true,
  });
}

/**
 * iOS: pins the app shell (`--app-height` / `--app-top`, read by
 * TerminalContent) to the visual viewport — exactly what is on screen. The
 * keyboard shrinks AND pans it, so the bottom-anchored query box sits flush on
 * the keyboard; with no keyboard it is the screen (PWA) or the area above the
 * toolbar (Safari tab). After the keyboard closes, an installed PWA can stay
 * short of the screen by the status-bar inset, and a shell sized to the
 * screen had its bottom (the query box toolbar) cut off at that boundary.
 * Pinch zoom also shrinks the visual viewport; it keeps the layout viewport.
 */
function setAppShellGeometry(vv: VisualViewport): void {
  const zoomed = Math.abs((vv.scale ?? 1) - 1) > 0.01;
  const height = zoomed ? window.innerHeight : vv.height;
  const top = zoomed ? 0 : (vv.offsetTop ?? 0);
  const root = document.documentElement.style;
  root.setProperty('--app-height', `${height}px`);
  root.setProperty('--app-top', `${top}px`);
  reportShellGeometry(height, top, vv);
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
    reportedShellHeight = null;
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
