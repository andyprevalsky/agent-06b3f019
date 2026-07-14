import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptMacAppHandoff } from '@/lib/macAppHandoff';

describe('attemptMacAppHandoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('downloads when the deep link does not leave the web page', () => {
    vi.useFakeTimers();
    const openApp = vi.fn();
    const download = vi.fn();

    attemptMacAppHandoff({ openApp, download, fallbackDelayMs: 500 });

    expect(openApp).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(download).toHaveBeenCalledOnce();
  });

  it('does not download after the browser loses focus to the Mac app', () => {
    vi.useFakeTimers();
    const download = vi.fn();

    attemptMacAppHandoff({ openApp: vi.fn(), download, fallbackDelayMs: 500 });
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(500);

    expect(download).not.toHaveBeenCalled();
  });

  it('does not download after the web page becomes hidden', () => {
    vi.useFakeTimers();
    const download = vi.fn();
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

    try {
      attemptMacAppHandoff({ openApp: vi.fn(), download, fallbackDelayMs: 500 });
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(500);

      expect(download).not.toHaveBeenCalled();
    } finally {
      if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
      else delete (document as Document & { hidden?: boolean }).hidden;
    }
  });

  it('downloads immediately when starting the deep link throws', () => {
    vi.useFakeTimers();
    const download = vi.fn();

    attemptMacAppHandoff({
      openApp: () => {
        throw new Error('unsupported protocol');
      },
      download,
      fallbackDelayMs: 500,
    });

    expect(download).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500);
    expect(download).toHaveBeenCalledOnce();
  });
});
