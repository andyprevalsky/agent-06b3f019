/**
 * Blackbox tests for src/features/app-wiring/hooks.ts.
 *
 * Covers the three side-effect installers called once at app startup:
 *   - initDevLogging   — patches console methods in dev
 *   - initAmplitude    — configures analytics with session replay
 *   - initViewportHeight — writes --vh CSS var and installs listeners
 *
 * We mock analytics and the session-replay plugin so we can assert behaviour
 * without touching real Amplitude.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the analytics module (canonical import)
vi.mock('@/lib/analytics', () => ({
  init: vi.fn(),
  addPlugin: vi.fn(),
  track: vi.fn(),
  setUserId: vi.fn(),
  reset: vi.fn(),
}));

// Mock the session-replay plugin so no network / real plugin is built
vi.mock('@amplitude/plugin-session-replay-browser', () => ({
  sessionReplayPlugin: vi.fn((cfg: unknown) => ({ __plugin: 'session-replay', cfg })),
}));

// Mock the sendDevLog side-effect transport
vi.mock('@/features/app-wiring/api', () => ({
  sendDevLog: vi.fn(),
}));

// Mock config to force IS_DEV=true and pass stable values
vi.mock('@/features/app-wiring/config', () => ({
  AMPLITUDE_API_KEY: 'test-amp-key',
  SESSION_REPLAY_SAMPLE_RATE: 1,
  IS_DEV: true,
  VH_REMEASURE_DELAY_MS: 50,
}));

import * as analytics from '@/lib/analytics';
import { sessionReplayPlugin } from '@amplitude/plugin-session-replay-browser';
import { sendDevLog } from '@/features/app-wiring/api';
import {
  initDevLogging,
  initAmplitude,
  initViewportHeight,
} from '@/features/app-wiring/hooks';

describe('app-wiring/hooks', () => {
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    userAgent: navigator.userAgent,
    innerHeight: window.innerHeight,
    visualViewport: Object.getOwnPropertyDescriptor(window, 'visualViewport'),
    hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // eslint-disable-next-line no-console -- restoring spies
    console.log = originals.log;
    // eslint-disable-next-line no-console -- restoring spies
    console.warn = originals.warn;
    // eslint-disable-next-line no-console -- restoring spies
    console.error = originals.error;
    Object.defineProperty(navigator, 'userAgent', {
      value: originals.userAgent,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: originals.innerHeight,
      configurable: true,
      writable: true,
    });
    if (originals.visualViewport) {
      Object.defineProperty(window, 'visualViewport', originals.visualViewport);
    } else {
      // jsdom default: delete any override the test installed
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
    if (originals.hidden) {
      Object.defineProperty(Document.prototype, 'hidden', originals.hidden);
    }
    document.documentElement.style.removeProperty('--vh');
  });

  describe('initDevLogging', () => {
    it('patches console.log/warn/error to forward logs to the backend', () => {
      const originalLog = console.log;
      initDevLogging();
      expect(console.log).not.toBe(originalLog);

      console.log('hello', 1);
      console.warn('warn-thing');
      console.error('err-thing');

      expect(sendDevLog).toHaveBeenCalledWith('log', ['hello', 1]);
      expect(sendDevLog).toHaveBeenCalledWith('warn', ['warn-thing']);
      expect(sendDevLog).toHaveBeenCalledWith('error', ['err-thing']);
    });

    it('preserves original console output (forwards to original fn)', () => {
      const origSpy = vi.fn();
      // eslint-disable-next-line no-console -- intentional override for test
      console.log = origSpy;
      initDevLogging();
      console.log('still works');
      expect(origSpy).toHaveBeenCalledWith('still works');
    });

    it('no-ops when IS_DEV is false', async () => {
      vi.resetModules();
      vi.doMock('@/features/app-wiring/config', () => ({
        AMPLITUDE_API_KEY: 'k',
        SESSION_REPLAY_SAMPLE_RATE: 1,
        IS_DEV: false,
        VH_REMEASURE_DELAY_MS: 50,
      }));
      const { initDevLogging: initProd } = await import('@/features/app-wiring/hooks');
      const originalLog = console.log;
      initProd();
      // console.log is unchanged
      expect(console.log).toBe(originalLog);
      vi.doUnmock('@/features/app-wiring/config');
      vi.resetModules();
    });
  });

  describe('initAmplitude', () => {
    it('installs session replay plugin and initializes analytics', () => {
      initAmplitude();
      expect(sessionReplayPlugin).toHaveBeenCalledWith({ sampleRate: 1 });
      expect(analytics.addPlugin).toHaveBeenCalled();
      expect(analytics.init).toHaveBeenCalledWith('test-amp-key', { autocapture: true });
    });
  });

  describe('initViewportHeight', () => {
    it('sets --vh on documentElement based on window.innerHeight', () => {
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      initViewportHeight();
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('9px');
    });

    it('listens for resize and updates --vh on change', () => {
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
      initViewportHeight();
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('5px');

      // Change innerHeight then dispatch a resize event
      Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
      window.dispatchEvent(new Event('resize'));
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('10px');
    });

    it('listens for orientationchange and re-measures after delay', () => {
      vi.useFakeTimers();
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
      initViewportHeight();
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      window.dispatchEvent(new Event('orientationchange'));
      // Before timer fires, value is still old
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('5px');
      vi.advanceTimersByTime(100);
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('8px');
      vi.useRealTimers();
    });

    it('on iOS, attaches visualViewport listeners that update --vh', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile/15E148',
        configurable: true,
      });
      // Install a spying visualViewport
      const listeners: Record<string, Array<() => void>> = { resize: [], scroll: [] };
      const visualViewportMock = {
        height: 400,
        addEventListener: (ev: string, fn: () => void) => {
          listeners[ev] ??= [];
          listeners[ev].push(fn);
        },
        removeEventListener: vi.fn(),
      };
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: visualViewportMock,
      });

      initViewportHeight();
      // Fire the visualViewport resize listener
      listeners.resize[0]?.();
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('4px');

      // Also dispatch focus/blur/visibilitychange; these schedule timers.
      vi.useFakeTimers();
      Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
      window.dispatchEvent(new Event('focus'));
      vi.advanceTimersByTime(100);
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('7px');

      Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
      window.dispatchEvent(new Event('blur'));
      vi.advanceTimersByTime(100);
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6px');

      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(100);
      expect(document.documentElement.style.getPropertyValue('--vh')).toBe('5px');
      vi.useRealTimers();
    });
  });
});
