/**
 * Blackbox tests for src/features/app-wiring/hooks.ts.
 *
 * Covers the three side-effect installers called once at app startup:
 *   - initDevLogging   — patches console methods in dev
 *   - initAmplitude    — configures analytics with session replay
 *   - initViewportHeight — writes --vh CSS var and installs listeners
 *   - initViewportScale — writes --app-rem-scale for compact desktop windows
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
  flush: vi.fn(),
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
  VIEWPORT_SCALE_MIN_WIDTH: 768,
  VIEWPORT_SCALE_DESIGN_WIDTH: 1440,
  VIEWPORT_SCALE_DESIGN_HEIGHT: 900,
  VIEWPORT_SCALE_MIN: 0.7,
}));

import * as analytics from '@/lib/analytics';
import { sessionReplayPlugin } from '@amplitude/plugin-session-replay-browser';
import { sendDevLog } from '@/features/app-wiring/api';
import {
  initDevLogging,
  initAmplitude,
  initViewportHeight,
  computeViewportScale,
  initViewportScale,
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
    innerWidth: window.innerWidth,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    console.log = originals.log;
    console.warn = originals.warn;
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
    Object.defineProperty(window, 'innerWidth', {
      value: originals.innerWidth,
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
    document.documentElement.style.removeProperty('--app-rem-scale');
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
        VIEWPORT_SCALE_MIN_WIDTH: 768,
        VIEWPORT_SCALE_DESIGN_WIDTH: 1440,
        VIEWPORT_SCALE_DESIGN_HEIGHT: 900,
        VIEWPORT_SCALE_MIN: 0.7,
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
      expect(analytics.init).toHaveBeenCalledWith('test-amp-key', {
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

  describe('iOS app shell follows the visible viewport (installed PWA)', () => {
    // iPhone 17 Pro Max PWA (440x956, 62pt status-bar inset). The keyboard
    // shrinks AND pans the visual viewport. After it closes, iOS can leave the
    // web content short of the screen by the status-bar inset (894): nothing
    // is painted below that, so a shell sized to the screen had its bottom
    // 62pt — the query box's toolbar row — cut off (user screenshot 2026-11-04).
    const SCREEN = { width: 440, height: 956 };
    let vv: { height: number; offsetTop: number; scale: number };
    let fire: () => void;

    beforeEach(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605 Mobile/15E148',
        configurable: true,
      });
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
      Object.defineProperty(window, 'screen', {
        value: { ...SCREEN },
        configurable: true,
      });
      Object.defineProperty(window, 'innerWidth', { value: 440, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 956, configurable: true });
      vv = { height: 956, offsetTop: 0, scale: 1 };
      const listeners: Array<() => void> = [];
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: {
          get height() {
            return vv.height;
          },
          get offsetTop() {
            return vv.offsetTop;
          },
          get scale() {
            return vv.scale;
          },
          addEventListener: (_ev: string, fn: () => void) => listeners.push(fn),
          removeEventListener: vi.fn(),
        },
      });
      fire = () => listeners.forEach((fn) => fn());
    });

    afterEach(() => {
      delete (navigator as { standalone?: boolean }).standalone;
      document.documentElement.style.removeProperty('--app-height');
      document.documentElement.style.removeProperty('--app-top');
    });

    const shell = () => ({
      height: document.documentElement.style.getPropertyValue('--app-height'),
      top: document.documentElement.style.getPropertyValue('--app-top'),
    });

    it('fills the whole screen when iOS shows the whole screen', () => {
      initViewportHeight();
      expect(shell()).toEqual({ height: '956px', top: '0px' });
    });

    it('ends exactly at the keyboard top while typing, then returns to full screen', () => {
      initViewportHeight();
      vv = { height: 577, offsetTop: 335, scale: 1 };
      fire();
      expect(shell()).toEqual({ height: '577px', top: '335px' });
      vv = { height: 956, offsetTop: 0, scale: 1 };
      fire();
      expect(shell()).toEqual({ height: '956px', top: '0px' });
    });

    it('never extends past the visible viewport when iOS leaves it short after the keyboard closes', () => {
      initViewportHeight();
      vv = { height: 577, offsetTop: 335, scale: 1 };
      fire();
      Object.defineProperty(window, 'innerHeight', { value: 894, configurable: true });
      vv = { height: 894, offsetTop: 0, scale: 1 };
      fire();
      expect(shell()).toEqual({ height: '894px', top: '0px' });
    });

    it('at rest with a short standalone viewport (10-30 report: 873 of 932), matches it rather than the screen', () => {
      // Deliberate trade-off: if iOS reports less than the screen, the box sits
      // at that boundary (a band may show below it) instead of being cut off.
      Object.defineProperty(window, 'screen', {
        value: { width: 430, height: 932 },
        configurable: true,
      });
      Object.defineProperty(window, 'innerWidth', { value: 430, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 873, configurable: true });
      vv = { height: 873, offsetTop: 0, scale: 1 };
      initViewportHeight();
      expect(shell()).toEqual({ height: '873px', top: '0px' });
    });

    it('reports the real viewport numbers once per keyboard transition, not on jitter', () => {
      vi.mocked(analytics.track).mockClear();
      initViewportHeight();
      vv = { height: 577, offsetTop: 335, scale: 1 };
      fire();
      vv = { height: 560, offsetTop: 352, scale: 1 };
      fire();
      Object.defineProperty(window, 'innerHeight', { value: 894, configurable: true });
      vv = { height: 894, offsetTop: 0, scale: 1 };
      fire();
      const reports = vi
        .mocked(analytics.track)
        .mock.calls.filter(([event]) => event === 'iOS Viewport Geometry')
        .map(([, props]) => props);
      expect(reports).toEqual([
        expect.objectContaining({ shell_height: 956, inner_height: 956, standalone: true }),
        expect.objectContaining({ shell_height: 577, shell_top: 335, visual_offset_top: 335 }),
        expect.objectContaining({ shell_height: 894, inner_height: 894, visual_height: 894 }),
      ]);
    });

    it('ignores pinch zoom, which shrinks the visual viewport without a keyboard', () => {
      initViewportHeight();
      vv = { height: 400, offsetTop: 120, scale: 2 };
      fire();
      expect(shell()).toEqual({ height: '956px', top: '0px' });
    });

    it('in a Safari tab, keeps the browser-owned toolbar space', () => {
      delete (navigator as { standalone?: boolean }).standalone;
      Object.defineProperty(window, 'innerHeight', { value: 873, configurable: true });
      vv = { height: 873, offsetTop: 0, scale: 1 };
      initViewportHeight();
      expect(shell()).toEqual({ height: '873px', top: '0px' });
    });
  });

  describe('computeViewportScale', () => {
    it('does not scale mobile-width layouts', () => {
      expect(computeViewportScale(390, 844)).toBe(1);
    });

    it('keeps full-size desktop layouts at 1', () => {
      expect(computeViewportScale(1440, 900)).toBe(1);
      expect(computeViewportScale(1728, 1117)).toBe(1);
    });

    it('scales compact desktop windows using the tighter viewport dimension', () => {
      expect(computeViewportScale(1440, 810)).toBe(0.9);
      expect(computeViewportScale(1280, 900)).toBe(0.889);
    });

    it('allows compact desktops to scale down toward repeated browser zoom-out levels', () => {
      expect(computeViewportScale(1152, 900)).toBe(0.8);
      expect(computeViewportScale(1024, 640)).toBe(0.711);
    });

    it('never scales compact desktops below the configured minimum', () => {
      expect(computeViewportScale(900, 500)).toBe(0.7);
    });
  });

  describe('initViewportScale', () => {
    it('sets --app-rem-scale from the current viewport', () => {
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 810, configurable: true });
      initViewportScale();
      expect(document.documentElement.style.getPropertyValue('--app-rem-scale')).toBe('0.9');
    });

    it('updates --app-rem-scale on resize', () => {
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      initViewportScale();
      expect(document.documentElement.style.getPropertyValue('--app-rem-scale')).toBe('1');

      Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
      window.dispatchEvent(new Event('resize'));
      expect(document.documentElement.style.getPropertyValue('--app-rem-scale')).toBe('0.889');
    });

    it('updates --app-rem-scale after orientationchange delay', () => {
      vi.useFakeTimers();
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      initViewportScale();

      Object.defineProperty(window, 'innerHeight', { value: 810, configurable: true });
      window.dispatchEvent(new Event('orientationchange'));
      expect(document.documentElement.style.getPropertyValue('--app-rem-scale')).toBe('1');

      vi.advanceTimersByTime(100);
      expect(document.documentElement.style.getPropertyValue('--app-rem-scale')).toBe('0.9');
      vi.useRealTimers();
    });
  });
});
