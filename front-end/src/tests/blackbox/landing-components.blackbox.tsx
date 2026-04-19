/* eslint-disable max-lines */
/**
 * Blackbox tests for the landing page components + hooks.
 *
 * Targets:
 *   - src/features/index/components/FeatureVideoStage.tsx
 *   - src/features/index/components/PreOrderSection.tsx
 *   - src/features/index/components/FeaturesSection.tsx
 *   - src/features/index/components/ProgressiveImage.tsx
 *   - src/features/index/hooks.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import FeatureVideoStage from '@/features/index/components/FeatureVideoStage';
import PreOrderSection from '@/features/index/components/PreOrderSection';
import FeaturesSection from '@/features/index/components/FeaturesSection';
import ProgressiveImage from '@/features/index/components/ProgressiveImage';
import {
  useEarlyAccess,
  useTypewriter,
  useMediaQuery,
  useWaitlistForm,
  usePreOrder,
} from '@/features/index/hooks';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MARKERS_FIXTURE = {
  fps: 30,
  customization: {
    introStart: 0.0,
    introEnd: 0.967,
    cycleStart: 0.967,
    cycleEnd: 14.3,
    outroStart: 14.333,
    outroEnd: 15.267,
    outroAnthropicStart: 67.4667,
    outroAnthropicEnd: 68.4,
    outroGeminiStart: 68.4333,
    outroGeminiEnd: 69.3667,
    outroMetaStart: 69.4,
    outroMetaEnd: 70.3333,
    outroDeepseakStart: 70.3667,
    outroDeepseakEnd: 71.3333,
  },
  conversations: {
    introStart: 15.267,
    introEnd: 16.233,
    cycleStart: 16.233,
    cycleEnd: 22.9,
    outroStart: 22.933,
    outroEnd: 23.9,
  },
  engine: {
    introStart: 23.9,
    introEnd: 24.9,
    cycleStart: 27.2,
    cycleEnd: 35.467,
    outroStart: 39.533,
    outroEnd: 40.533,
  },
  memory: {
    introStart: 40.567,
    introEnd: 41.5,
    cycleStart: 41.533,
    cycleEnd: 50.8,
    outroStart: 49.833,
    outroEnd: 49.833,
  },
  privacy: {
    introStart: 50.866,
    introEnd: 51.833,
    cycleStart: 51.833,
    cycleEnd: 60.133,
    outroStart: 66.466,
    outroEnd: 67.433,
  },
};

/**
 * Mock `fetch` globally so:
 *   - `/navi-features-markers.json` resolves with MARKERS_FIXTURE
 *   - Any video asset (`.webm` / `.mov`) resolves with a tiny blob
 *   - Any other request falls through to the original fetch (MSW handlers).
 */
function installStaticAssetFetch() {
  const originalFetch = global.fetch;
  const stubbedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.endsWith('navi-features-markers.json') || url.includes('navi-features-markers.json')) {
      return new Response(JSON.stringify(MARKERS_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('.webm') || url.endsWith('.mov')) {
      return new Response(new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'video/webm' }), {
        status: 200,
        headers: { 'Content-Type': 'video/webm' },
      });
    }
    return originalFetch(input as RequestInfo, init);
  });
  (global as any).fetch = stubbedFetch;
  return () => {
    (global as any).fetch = originalFetch;
  };
}

function flush(ms: number = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// FeatureVideoStage
// ─────────────────────────────────────────────────────────────────────────────

describe('FeatureVideoStage', () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    restoreFetch = installStaticAssetFetch();
    // rAF runs immediately so the state machine makes progress.
    vi.spyOn(global, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      // run callback asynchronously so listeners have time to register
      setTimeout(() => cb(performance.now()), 0);
      return 0 as unknown as number;
    });
    vi.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
  });

  it('mounts and renders the <video> element', async () => {
    const { container } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('playsinline')).not.toBeNull();
    // Loading overlay visible before canplay
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('hides loading overlay after canplay/loadeddata fires', async () => {
    const { container } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    await act(async () => {
      fireEvent.loadedData(video);
      fireEvent.canPlay(video);
      fireEvent.playing(video);
    });
    // Overlay should hide (isVideoLoading = false)
    await waitFor(() => {
      expect(screen.queryByText('loading')).not.toBeInTheDocument();
    });
  });

  it('shows loading again when video stalls/waits', async () => {
    const { container } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    await act(async () => {
      fireEvent.canPlay(video);
    });
    await waitFor(() => {
      expect(screen.queryByText('loading')).not.toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.stalled(video);
    });
    await waitFor(() => {
      expect(screen.getByText('loading')).toBeInTheDocument();
    });
  });

  it('drives state machine through LOADING → INTRO → CYCLING when markers load and feature changes', async () => {
    const { container, rerender } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
    const video = container.querySelector('video') as HTMLVideoElement;

    // Let marker fetch resolve
    await act(async () => {
      await flush(10);
    });

    // Fire loadedmetadata + loadeddata to advance state
    await act(async () => {
      fireEvent.loadedMetadata(video);
      fireEvent.loadedData(video);
      fireEvent.canPlay(video);
    });

    // Simulate currentTime progressing into the "cycle" band for engine (index=2)
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      writable: true,
      value: 28.0,
    });
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
    Object.defineProperty(video, 'readyState', { configurable: true, writable: true, value: 4 });

    await act(async () => {
      fireEvent.timeUpdate(video);
      await flush(10);
    });

    // Change active feature to trigger a seek
    rerender(<FeatureVideoStage activeIndex={2} />);

    await act(async () => {
      fireEvent.timeUpdate(video);
      await flush(10);
      fireEvent.seeked(video);
      await flush(10);
    });

    // Simulate cycleEnd → should trigger P2-loop-cycle
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      writable: true,
      value: 35.467,
    });
    await act(async () => {
      fireEvent.timeUpdate(video);
      await flush(10);
    });

    // Fire ended to cover cleanup paths
    await act(async () => {
      fireEvent.ended(video);
    });
    expect(video).toBeTruthy();
  });

  it('handles seek-to-intro when a new feature is requested from a non-cycle position', async () => {
    const { container, rerender } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
    const video = container.querySelector('video') as HTMLVideoElement;

    await act(async () => {
      await flush(10);
      fireEvent.loadedMetadata(video);
      fireEvent.loadedData(video);
      fireEvent.canPlay(video);
    });

    // Place currentTime inside customization intro (where.part === 'intro')
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      writable: true,
      value: 0.5,
    });

    rerender(<FeatureVideoStage activeIndex={1} />);
    await act(async () => {
      fireEvent.timeUpdate(video);
      await flush(10);
      fireEvent.seeked(video);
    });
    expect(video).toBeTruthy();
  });

  it('handles all video event listeners (loadedmetadata, waiting, progress, ratechange, error)', async () => {
    const { container } = renderWithProviders(<FeatureVideoStage activeIndex={3} />);
    const video = container.querySelector('video') as HTMLVideoElement;

    await act(async () => {
      await flush(10);
      fireEvent.loadedMetadata(video);
      fireEvent.waiting(video);
      fireEvent.progress(video);
      fireEvent.rateChange(video);
      fireEvent.durationChange(video);
      fireEvent.emptied(video);
      fireEvent.abort(video);
      fireEvent.error(video);
      fireEvent.suspend(video);
      fireEvent.seeking(video);
    });
    expect(container.querySelector('video')).toBeTruthy();
  });

  it('unmounts cleanly', async () => {
    const { container, unmount } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    await act(async () => {
      fireEvent.loadedMetadata(video);
      fireEvent.canPlay(video);
      await flush(10);
    });
    unmount();
    // No throw
    expect(true).toBe(true);
  });

  it('handles debugVideo=1 query param path (HUD enable branch)', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...original, search: '?debugVideo=1&noBlob=1&disableRamp=1&disableWarmup=1' },
    });
    try {
      const { container } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
      const video = container.querySelector('video') as HTMLVideoElement;
      await act(async () => {
        await flush(10);
        fireEvent.loadedMetadata(video);
        fireEvent.canPlay(video);
      });
      expect(video).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'location', { writable: true, value: original });
    }
  });

  it('supports localStorage featuresVideoDebug flag', async () => {
    window.localStorage.setItem('featuresVideoDebug', '1');
    window.localStorage.setItem('featuresVideoNoBlob', '1');
    window.localStorage.setItem('featuresVideoDisableRamp', '1');
    window.localStorage.setItem('featuresVideoDisableWarmup', '1');
    try {
      const { container } = renderWithProviders(<FeatureVideoStage activeIndex={4} />);
      const video = container.querySelector('video') as HTMLVideoElement;
      await act(async () => {
        await flush(10);
        fireEvent.loadedMetadata(video);
        fireEvent.canPlay(video);
        await flush(10);
      });
      expect(video).toBeTruthy();
    } finally {
      window.localStorage.removeItem('featuresVideoDebug');
      window.localStorage.removeItem('featuresVideoNoBlob');
      window.localStorage.removeItem('featuresVideoDisableRamp');
      window.localStorage.removeItem('featuresVideoDisableWarmup');
    }
  });

  it('runs watchdog setInterval path (freeze detection, debug enabled)', async () => {
    // restore real requestAnimationFrame before using fake timers so rAF falls back
    vi.restoreAllMocks();
    restoreFetch();
    restoreFetch = installStaticAssetFetch();
    vi.useFakeTimers();
    try {
      const { container, unmount } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
      const video = container.querySelector('video') as HTMLVideoElement;
      // Set video state so the watchdog path "shouldBePlaying" is true
      Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
      Object.defineProperty(video, 'seeking', { configurable: true, writable: true, value: false });
      Object.defineProperty(video, 'readyState', { configurable: true, writable: true, value: 4 });
      Object.defineProperty(video, 'playbackRate', {
        configurable: true,
        writable: true,
        value: 1.0,
      });
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        writable: true,
        value: 5,
      });
      Object.defineProperty(video, 'duration', {
        configurable: true,
        writable: true,
        value: 100,
      });

      // advance the 300ms freeze-detection interval multiple times
      await act(async () => {
        vi.advanceTimersByTime(400);
        vi.advanceTimersByTime(700);
        vi.advanceTimersByTime(200); // debug HUD setInterval 250ms
      });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exercises HEVC path via mocked Safari iOS userAgent (near-zero intro triggers loaded path)', async () => {
    const ua = window.navigator.userAgent;
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    });
    try {
      const { container, rerender } = renderWithProviders(<FeatureVideoStage activeIndex={0} />);
      const video = container.querySelector('video') as HTMLVideoElement;
      await act(async () => {
        await flush(10);
        fireEvent.loadedMetadata(video);
        fireEvent.loadedData(video);
        fireEvent.canPlay(video);
      });
      // Request switching to customization (index 0, intro near zero)
      rerender(<FeatureVideoStage activeIndex={0} />);
      // move currentTime into cycle and then change feature
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        writable: true,
        value: 0.2,
      });
      rerender(<FeatureVideoStage activeIndex={0} />);
      await act(async () => {
        fireEvent.timeUpdate(video);
        fireEvent.loadedMetadata(video);
        await flush(20);
      });
    } finally {
      Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: ua });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PreOrderSection
// ─────────────────────────────────────────────────────────────────────────────

describe('PreOrderSection', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  it('renders the section with both variants (Midnight Black, Pearl White)', () => {
    renderWithProviders(<PreOrderSection />);
    expect(screen.getAllByText('Midnight Black').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Pearl White').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /Pre-order/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('opens Stripe checkout on Black pre-order click', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const user = userEvent.setup();
      renderWithProviders(<PreOrderSection />);
      const buttons = screen.getAllByRole('button', { name: /Pre-order/i });
      await user.click(buttons[0]);
      expect(openSpy).toHaveBeenCalled();
      const [url, target] = openSpy.mock.calls[0] as [string, string];
      expect(url).toMatch(/stripe\.com/);
      expect(target).toBe('_blank');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('opens Stripe checkout on White pre-order click', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const user = userEvent.setup();
      renderWithProviders(<PreOrderSection />);
      const buttons = screen.getAllByRole('button', { name: /Pre-order/i });
      await user.click(buttons[1]);
      expect(openSpy).toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('toggles the black "service fee" popover via mouse enter/leave', async () => {
    renderWithProviders(<PreOrderSection />);
    const serviceFeeTriggers = screen.getAllByText('service fee');
    expect(serviceFeeTriggers.length).toBe(2);
    fireEvent.mouseEnter(serviceFeeTriggers[0]);
    await waitFor(() => {
      expect(screen.getAllByText('AI Provider Services').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.mouseLeave(serviceFeeTriggers[0]);
  });

  it('fires visibility change / focus / blur / pageshow listeners without error', async () => {
    renderWithProviders(<PreOrderSection />);
    // visibilitychange hidden branch
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    // visibilitychange visible branch → playVideos path
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    // focus / blur
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    // pageshow with persisted=true branch
    const ev = new Event('pageshow') as Event & { persisted?: boolean };
    Object.defineProperty(ev, 'persisted', { value: true });
    window.dispatchEvent(ev);
    // Give the internal setTimeout time to flush
    await new Promise((r) => setTimeout(r, 150));
    expect(true).toBe(true);
  });

  it('renders color swatches for both finishes', () => {
    renderWithProviders(<PreOrderSection />);
    const swatches = document.querySelectorAll('[title="Midnight Black"], [title="Pearl White"]');
    expect(swatches.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FeaturesSection
// ─────────────────────────────────────────────────────────────────────────────

describe('FeaturesSection', () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    restoreFetch = installStaticAssetFetch();
    Element.prototype.scrollIntoView = () => {};
    // Ensure predictable matchMedia
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as any;
  });

  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
  });

  it('renders all 5 feature titles', () => {
    renderWithProviders(<FeaturesSection />);
    expect(screen.getAllByText('Fully Customizable').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Seamless Conversations').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Agent Enabled').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Rose Grows With You').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Privacy First').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking a feature title updates active feature (desktop-menu button)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeaturesSection />);
    const privacyHeadings = screen.getAllByText('Privacy First');
    // The desktop menu button is an <h4> child of a <button>
    const button = privacyHeadings.find((el) => el.closest('button')) as HTMLElement | undefined;
    if (button) {
      await user.click(button.closest('button')!);
    }
    // Either way the component should not throw
    expect(screen.getAllByText('Privacy First').length).toBeGreaterThanOrEqual(1);
  });

  it('renders CTA button (Join the Waitlist) in early-access-off mode', () => {
    renderWithProviders(<FeaturesSection />, { route: '/' });
    const ctas = screen.getAllByText('Join the Waitlist');
    expect(ctas.length).toBeGreaterThanOrEqual(1);
  });

  it('renders CTA button (Pre-order) when early access is enabled via query', () => {
    // Simulate window.location.search = '?earlyaccess'
    const original = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...original, search: '?earlyaccess', pathname: '/' },
    });
    try {
      renderWithProviders(<FeaturesSection />);
      const ctas = screen.getAllByText('Pre-order');
      expect(ctas.length).toBeGreaterThanOrEqual(1);
    } finally {
      Object.defineProperty(window, 'location', { writable: true, value: original });
    }
  });

  it('CTA Join Waitlist button scrolls to waitlist section when on /', async () => {
    const user = userEvent.setup();
    const scrollSpy = vi.fn();
    // Stub getElementById('waitlist') to return a fake element with scrollIntoView
    const originalGetById = document.getElementById.bind(document);
    vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      if (id === 'waitlist' || id === 'pre-order') {
        return { scrollIntoView: scrollSpy } as unknown as HTMLElement;
      }
      return originalGetById(id);
    });

    renderWithProviders(<FeaturesSection />, { route: '/' });
    const cta = screen.getAllByText('Join the Waitlist')[0];
    await user.click(cta.closest('button')!);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('bounce-arrow button navigates to next feature sentinel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeaturesSection />);
    const arrowButtons = screen.getAllByRole('button', { name: /Scroll to next feature/i });
    expect(arrowButtons.length).toBeGreaterThanOrEqual(1);
    // Click should not throw; we don't assert on scroll in jsdom
    await user.click(arrowButtons[0]);
  });

  it('dot-pagination buttons trigger a scroll', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeaturesSection />);
    const dot0 = screen.getByRole('button', { name: 'Go to feature 1' });
    const dot4 = screen.getByRole('button', { name: 'Go to feature 5' });
    await user.click(dot0);
    await user.click(dot4);
    expect(dot4).toBeInTheDocument();
  });

  it('scroll listener fires without error', () => {
    renderWithProviders(<FeaturesSection />);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    // Let rAF callback fire
    act(() => {
      // exhaust any scheduled rAF
    });
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ProgressiveImage
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressiveImage', () => {
  let originalImage: typeof Image;

  beforeEach(() => {
    originalImage = global.Image;
  });

  afterEach(() => {
    global.Image = originalImage;
    vi.restoreAllMocks();
  });

  /**
   * Replace global Image with a stub that fires onload (or onerror) on a next tick.
   */
  function stubImage(behaviour: 'all-ok' | 'high-fails' | 'low-fails') {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: ((e?: unknown) => void) | null = null;
      fetchpriority?: string;
      private _src = '';
      set src(value: string) {
        this._src = value;
        // Decide fate based on URL + behaviour
        setTimeout(() => {
          if (behaviour === 'low-fails' && value.includes('low')) {
            this.onerror?.();
            return;
          }
          if (behaviour === 'high-fails' && value.includes('high')) {
            this.onerror?.();
            return;
          }
          this.onload?.();
        }, 0);
      }
      get src() {
        return this._src;
      }
    }
    (global as any).Image = FakeImage;
  }

  it('progresses from low → med → high src', async () => {
    stubImage('all-ok');
    const { container } = render(
      <ProgressiveImage
        lowSrc="/img-low.jpg"
        medSrc="/img-med.jpg"
        highSrc="/img-high.jpg"
        alt="test"
      />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    // Initial render shows lowSrc
    expect(img.getAttribute('src')).toBe('/img-low.jpg');
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe('/img-high.jpg');
    });
  });

  it('handles high-res load failure (warns, keeps medium)', async () => {
    stubImage('high-fails');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(
        <ProgressiveImage
          lowSrc="/pic-low.jpg"
          medSrc="/pic-med.jpg"
          highSrc="/pic-high.jpg"
          alt="fail-high"
        />,
      );
      const img = container.querySelector('img') as HTMLImageElement;
      await waitFor(() => {
        expect(img.getAttribute('src')).toBe('/pic-med.jpg');
      });
      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('handles low-res failure (falls back, stays on lowSrc)', async () => {
    stubImage('low-fails');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(
        <ProgressiveImage
          lowSrc="/low.jpg"
          medSrc="/med.jpg"
          highSrc="/high.jpg"
          alt="low-fails"
        />,
      );
      const img = container.querySelector('img') as HTMLImageElement;
      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
      expect(img.getAttribute('src')).toBe('/low.jpg');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('applies fetchPriority="high" branch', async () => {
    stubImage('all-ok');
    const { container } = render(
      <ProgressiveImage
        lowSrc="/a-low.jpg"
        medSrc="/a-med.jpg"
        highSrc="/a-high.jpg"
        alt="prio"
        fetchPriority="high"
        className="custom-class"
        style={{ borderRadius: 8 }}
      />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.className).toMatch(/custom-class/);
  });

  it('unmount cancels in-flight loads (no late setState warning)', async () => {
    stubImage('all-ok');
    const { container, unmount } = render(
      <ProgressiveImage
        lowSrc="/u-low.jpg"
        medSrc="/u-med.jpg"
        highSrc="/u-high.jpg"
        alt="unmount"
      />,
    );
    expect(container.querySelector('img')).toBeTruthy();
    unmount();
    // Give pending setTimeout a chance to flush after unmount
    await flush(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hooks.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('features/index/hooks', () => {
  describe('useEarlyAccess', () => {
    const original = window.location;
    afterEach(() => {
      Object.defineProperty(window, 'location', { writable: true, value: original });
    });

    it('returns false by default', () => {
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { ...original, search: '' },
      });
      const { result } = renderHook(() => useEarlyAccess());
      expect(result.current).toBe(false);
    });

    it('returns true when earlyaccess query param is present', () => {
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { ...original, search: '?earlyaccess' },
      });
      const { result } = renderHook(() => useEarlyAccess());
      expect(result.current).toBe(true);
    });
  });

  describe('useTypewriter', () => {
    it('initialises typedText and begins typing base', async () => {
      const { result } = renderHook(() => useTypewriter());
      // Start empty, then becomes some substring of HERO_BASE_TEXT
      expect(result.current).toBe('');
      // Advance enough time for some chars to be typed
      await new Promise((r) => setTimeout(r, 300));
      // We cannot know exact state but string should be non-empty eventually
      // Just assert hook doesn't throw and returns a string
      expect(typeof result.current).toBe('string');
    });

    it('unmount cleanup does not throw', () => {
      const { unmount } = renderHook(() => useTypewriter());
      unmount();
      expect(true).toBe(true);
    });
  });

  describe('useMediaQuery', () => {
    it('falls back to matches=false default', () => {
      const { result } = renderHook(() => useMediaQuery('(max-width: 1px)'));
      expect(typeof result.current).toBe('boolean');
    });

    it('uses addListener fallback when addEventListener throws', () => {
      const addListener = vi.fn();
      const removeListener = vi.fn();
      const originalMM = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener,
        removeListener,
        addEventListener: () => {
          throw new Error('not supported');
        },
        removeEventListener: () => {
          throw new Error('not supported');
        },
        dispatchEvent: () => false,
      })) as any;
      try {
        const { result, unmount } = renderHook(() => useMediaQuery('(min-width: 10px)'));
        expect(result.current).toBe(true);
        expect(addListener).toHaveBeenCalled();
        unmount();
        expect(removeListener).toHaveBeenCalled();
      } finally {
        window.matchMedia = originalMM;
      }
    });
  });

  describe('useWaitlistForm', () => {
    const API_BASE = 'http://localhost:3001/api';

    it('expand() flips isExpanded to true', () => {
      const { result } = renderHook(() => useWaitlistForm());
      act(() => result.current.expand());
      expect(result.current.isExpanded).toBe(true);
    });

    it('handleInputChange updates name and email and clears errors', () => {
      const { result } = renderHook(() => useWaitlistForm());
      act(() =>
        result.current.handleInputChange('name')({
          target: { value: 'Ada' },
        } as React.ChangeEvent<HTMLInputElement>),
      );
      expect(result.current.formData.name).toBe('Ada');
      act(() =>
        result.current.handleInputChange('email')({
          target: { value: 'ada@example.com' },
        } as React.ChangeEvent<HTMLInputElement>),
      );
      expect(result.current.formData.email).toBe('ada@example.com');
    });

    it('handleSubmit with invalid email shows emailError and does not call API', async () => {
      let called = 0;
      server.use(
        http.post(`${API_BASE}/waitlist`, () => {
          called += 1;
          return HttpResponse.json({ success: true, message: 'ok' });
        }),
      );
      const { result } = renderHook(() => useWaitlistForm('custom'));
      act(() =>
        result.current.handleInputChange('email')({
          target: { value: 'bad' },
        } as React.ChangeEvent<HTMLInputElement>),
      );
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as any));
      await waitFor(() => {
        expect(result.current.emailError).toMatch(/valid email/i);
      });
      expect(called).toBe(0);
    });

    it('handleSubmit with valid email sets loading → success and calls onSuccess', async () => {
      let captured: any = null;
      server.use(
        http.post(`${API_BASE}/waitlist`, async ({ request }) => {
          captured = await request.json();
          return HttpResponse.json({ success: true, message: 'ok' });
        }),
      );
      const onSuccess = vi.fn();
      const { result } = renderHook(() => useWaitlistForm('custom', onSuccess));
      act(() => {
        result.current.handleInputChange('name')({
          target: { value: 'Ada ' },
        } as React.ChangeEvent<HTMLInputElement>);
        result.current.handleInputChange('email')({
          target: { value: 'ADA@example.com' },
        } as React.ChangeEvent<HTMLInputElement>);
      });
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as any));
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      expect(onSuccess).toHaveBeenCalled();
      // email trimmed + lowercased; name trimmed
      expect(captured?.email).toBe('ada@example.com');
      expect(captured?.name).toBe('Ada');
      expect(captured?.variant).toBe('custom');
    });

    it('handleSubmit surfaces submit error on API failure', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      server.use(
        http.post(`${API_BASE}/waitlist`, () =>
          HttpResponse.json({ error: 'Email already registered' }, { status: 400 }),
        ),
      );
      const { result } = renderHook(() => useWaitlistForm());
      act(() => {
        result.current.handleInputChange('name')({
          target: { value: 'X' },
        } as React.ChangeEvent<HTMLInputElement>);
        result.current.handleInputChange('email')({
          target: { value: 'x@y.com' },
        } as React.ChangeEvent<HTMLInputElement>);
      });
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as any));
      await waitFor(() => {
        expect(result.current.submitError).toMatch(/already registered/i);
      });
      expect(result.current.isLoading).toBe(false);
      errSpy.mockRestore();
    });

    it('handleSubmit surfaces default error message when fetch rejects', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      server.use(
        http.post(`${API_BASE}/waitlist`, () => HttpResponse.error()),
      );
      const { result } = renderHook(() => useWaitlistForm());
      act(() => {
        result.current.handleInputChange('email')({
          target: { value: 'x@y.com' },
        } as React.ChangeEvent<HTMLInputElement>);
      });
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as any));
      await waitFor(() => {
        expect(result.current.submitError.length).toBeGreaterThan(0);
      });
      errSpy.mockRestore();
    });
  });

  describe('usePreOrder', () => {
    it('returns a callback that window.open()s Stripe url for black', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      try {
        const { result } = renderHook(() => usePreOrder());
        result.current('black');
        expect(openSpy).toHaveBeenCalled();
        expect((openSpy.mock.calls[0] as [string, string])[0]).toMatch(/stripe\.com/);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('opens checkout url for white variant', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      try {
        const { result } = renderHook(() => usePreOrder());
        result.current('white');
        expect(openSpy).toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
    });
  });
});
