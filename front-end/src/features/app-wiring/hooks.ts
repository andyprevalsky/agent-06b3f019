/**
 * App bootstrap side-effects: dev logging, analytics, viewport height.
 * Called once from main.tsx at app startup.
 */

import * as amplitude from '@amplitude/analytics-browser';
import { sessionReplayPlugin } from '@amplitude/plugin-session-replay-browser';

import {
  AMPLITUDE_API_KEY,
  SESSION_REPLAY_SAMPLE_RATE,
  DEV_LOG_ENDPOINT,
  VH_REMEASURE_DELAY_MS,
} from './config';

/** Patches console.log/warn/error to forward logs to the backend in dev mode. */
export function initDevLogging(): void {
  if (!import.meta.env.DEV) return;

  // eslint-disable-next-line no-console -- capturing originals for dev log forwarding
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const backendUrl = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(
    /\/$/,
    '',
  );

  const sendLog = (level: string, args: unknown[]) => {
    fetch(`${backendUrl}${DEV_LOG_ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        args: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))),
      }),
    }).catch(() => {}); // Silently fail if backend unavailable
  };

  // eslint-disable-next-line no-console -- patching console.log with forwarding wrapper
  console.log = (...args) => {
    originalLog(...args);
    sendLog('log', args);
  };
  console.warn = (...args) => {
    originalWarn(...args);
    sendLog('warn', args);
  };
  console.error = (...args) => {
    originalError(...args);
    sendLog('error', args);
  };
}

/** Initializes Amplitude analytics with session replay. */
export function initAmplitude(): void {
  amplitude.add(sessionReplayPlugin({ sampleRate: SESSION_REPLAY_SAMPLE_RATE }));
  amplitude.init(AMPLITUDE_API_KEY, { autocapture: true });
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
