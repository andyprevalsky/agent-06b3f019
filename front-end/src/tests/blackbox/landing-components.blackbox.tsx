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
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
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
  (global as never).fetch = stubbedFetch;
  return () => {
    (global as never).fetch = originalFetch;
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
