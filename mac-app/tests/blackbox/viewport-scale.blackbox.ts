import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeViewportScale, initViewportScale } from '../../ui/lib/viewport-scale';

describe('viewport scale', () => {
  const originals = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: originals.innerWidth,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: originals.innerHeight,
      configurable: true,
      writable: true,
    });
    document.documentElement.style.removeProperty('--app-rem-scale');
    vi.useRealTimers();
  });

  it('does not scale mobile-width layouts', () => {
    expect(computeViewportScale(390, 844)).toBe(1);
  });

  it('scales compact desktop windows using the tighter viewport dimension', () => {
    expect(computeViewportScale(1440, 810)).toBe(0.9);
    expect(computeViewportScale(1280, 900)).toBe(0.889);
    expect(computeViewportScale(1152, 900)).toBe(0.8);
    expect(computeViewportScale(1024, 640)).toBe(0.711);
  });

  it('never scales compact desktops below the configured minimum', () => {
    expect(computeViewportScale(900, 500)).toBe(0.7);
  });

  it('sets --app-rem-scale from the current Electron window viewport', () => {
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
  });
});
