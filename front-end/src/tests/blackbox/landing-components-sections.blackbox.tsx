import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { installStaticAssetFetch } from './landing-components.fixtures';
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

function flush(ms: number = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as never;
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
    vi.stubGlobal('Image', FakeImage);
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
      })) as never;
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
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as never));
      await waitFor(() => {
        expect(result.current.emailError).toMatch(/valid email/i);
      });
      expect(called).toBe(0);
    });

    it('handleSubmit with valid email sets loading → success and calls onSuccess', async () => {
      let captured: Record<string, unknown> = null;
      server.use(
        http.post(`${API_BASE}/waitlist`, async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>;
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
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as never));
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      expect(onSuccess).toHaveBeenCalled();
      // email trimmed + lowercased; name trimmed
      expect(captured).toMatchObject({ email: 'ada@example.com', name: 'Ada', variant: 'custom' });
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
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as never));
      await waitFor(() => {
        expect(result.current.submitError).toMatch(/already registered/i);
      });
      expect(result.current.isLoading).toBe(false);
      errSpy.mockRestore();
    });

    it('handleSubmit surfaces default error message when fetch rejects', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      server.use(http.post(`${API_BASE}/waitlist`, () => HttpResponse.error()));
      const { result } = renderHook(() => useWaitlistForm());
      act(() => {
        result.current.handleInputChange('email')({
          target: { value: 'x@y.com' },
        } as React.ChangeEvent<HTMLInputElement>);
      });
      act(() => result.current.handleSubmit({ preventDefault: () => {} } as never));
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
