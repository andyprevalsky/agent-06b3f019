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
} from './config';

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
