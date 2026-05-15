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
  // eslint-disable-next-line no-console -- intentional single startup message
  console.log(`[Frontend] Mode: ${IS_DEV ? 'DEVELOPMENT' : 'PRODUCTION'}`);
}

/** Patches console.log/warn/error to forward logs to the backend in dev mode. */
export function initDevLogging(): void {
  if (!IS_DEV) return;

  // eslint-disable-next-line no-console -- capturing originals for dev log forwarding
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  // eslint-disable-next-line no-console -- patching console.log with forwarding wrapper
  console.log = (...args) => {
    originalLog(...args);
    sendDevLog('log', args);
  };
  console.warn = (...args) => {
    originalWarn(...args);
    sendDevLog('warn', args);
  };
  console.error = (...args) => {
    originalError(...args);
    sendDevLog('error', args);
  };
}

/** Initializes Amplitude analytics with session replay. */
export function initAmplitude(): void {
  analytics.addPlugin(sessionReplayPlugin({ sampleRate: SESSION_REPLAY_SAMPLE_RATE }));
  analytics.init(AMPLITUDE_API_KEY, { autocapture: true });
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
    };
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
