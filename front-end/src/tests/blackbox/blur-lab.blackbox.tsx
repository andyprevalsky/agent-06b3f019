/**
 * Blackbox: the iOS blur lab is inert without ?blurlab=1 and, when active,
 * its toggles apply and revert the expected styles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import BlurLab from '@/dev/blur-lab/BlurLab';
import { mountBlurLabIfRequested } from '@/dev/blur-lab/mountBlurLab';
import { shouldActivateBlurLab } from '@/dev/blur-lab/blurLabEffects';

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

describe('blur lab', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setUrl('');
    document.head.innerHTML =
      '<meta name="apple-mobile-web-app-status-bar-style" content="default">';
  });
  afterEach(() => {
    document.getElementById('blur-lab-portal')?.remove();
    document.head.querySelectorAll('style[data-blurlab]').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  it('is absent without the param', () => {
    expect(shouldActivateBlurLab()).toBe(false);
    mountBlurLabIfRequested();
    expect(document.getElementById('blur-lab-portal')).toBeNull();
    expect(screen.queryByTestId('blur-lab')).toBeNull();
  });

  it('activates with the param and persists in sessionStorage', async () => {
    setUrl('?blurlab=1');
    expect(shouldActivateBlurLab()).toBe(true);
    setUrl('');
    expect(shouldActivateBlurLab()).toBe(true);
    mountBlurLabIfRequested();
    await waitFor(() => expect(document.getElementById('blur-lab-portal')).not.toBeNull());
  });

  it('stays off in Electron even with the param', () => {
    (window as typeof window & { api?: { isElectron?: boolean } }).api = { isElectron: true };
    setUrl('?blurlab=1');
    expect(shouldActivateBlurLab()).toBe(false);
    delete (window as typeof window & { api?: unknown }).api;
  });

  it('toggles apply and revert css and meta', () => {
    render(<BlurLab />);
    fireEvent.click(screen.getByText(/Blur lab/));

    fireEvent.click(screen.getByTestId('blurlab-no-backdrop'));
    expect(document.head.querySelector('style[data-blurlab="no-backdrop"]')?.textContent).toContain(
      'backdrop-filter:none',
    );
    fireEvent.click(screen.getByTestId('blurlab-no-backdrop'));
    expect(document.head.querySelector('style[data-blurlab="no-backdrop"]')).toBeNull();

    const meta = () =>
      document.querySelector<HTMLMetaElement>(
        'meta[name="apple-mobile-web-app-status-bar-style"]',
      )!;
    fireEvent.click(screen.getByTestId('blurlab-status-black'));
    expect(meta().content).toBe('black');
    fireEvent.click(screen.getByTestId('blurlab-status-black'));
    expect(meta().content).toBe('default');
  });

  it('hides a top fixed element and prints a report', () => {
    const bar = document.createElement('div');
    bar.style.position = 'fixed';
    bar.style.top = '0px';
    bar.id = 'fake-top';
    bar.getBoundingClientRect = () => new DOMRect(0, 0, 100, 40);
    document.body.appendChild(bar);
    render(<BlurLab />);
    fireEvent.click(screen.getByText(/Blur lab/));
    fireEvent.click(screen.getByText('Rescan'));
    fireEvent.click(screen.getByTestId('blurlab-hide-0'));
    expect(bar.style.visibility).toBe('hidden');
    fireEvent.click(screen.getByTestId('blurlab-hide-0'));
    expect(bar.style.visibility).toBe('');
    fireEvent.click(screen.getByTestId('blurlab-report'));
    expect(screen.getByTestId('blurlab-report-output').textContent).toContain('div#fake-top');
    bar.remove();
  });
});
