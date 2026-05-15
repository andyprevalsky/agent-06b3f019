import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import Browse from '@/features/browse/components/Browse';
import { DEFAULT_BROWSE_URL } from '@/features/browse/config';

interface FakeWebview extends HTMLElement {
  src: string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
}

let backCalls: number;
let forwardCalls: number;
let reloadCalls: number;
let canGoBackValue: boolean;
let canGoForwardValue: boolean;

beforeEach(() => {
  backCalls = 0;
  forwardCalls = 0;
  reloadCalls = 0;
  canGoBackValue = false;
  canGoForwardValue = false;

  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    if (tagName === 'webview') {
      const el = originalCreateElement('div', options) as unknown as FakeWebview;
      Object.defineProperty(el, 'src', { writable: true, value: DEFAULT_BROWSE_URL });
      el.canGoBack = () => canGoBackValue;
      el.canGoForward = () => canGoForwardValue;
      el.goBack = () => {
        backCalls += 1;
      };
      el.goForward = () => {
        forwardCalls += 1;
      };
      el.reload = () => {
        reloadCalls += 1;
      };
      return el as unknown as HTMLElement;
    }
    return originalCreateElement(tagName, options);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function findWebview(): FakeWebview {
  const root = document.querySelector('[class*="bg-white"]');
  if (root === null) throw new Error('Browse root not found');
  const webview = root.querySelector('div[class*="bg-white"]') as FakeWebview | null;
  if (webview === null) throw new Error('webview element not found');
  return webview;
}

describe('Browse', () => {
  it('renders toolbar with default URL', () => {
    renderWithProviders(<Browse />);
    const input = screen.getByLabelText('URL or search') as HTMLInputElement;
    expect(input.value).toBe(DEFAULT_BROWSE_URL);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
  });

  it('typing in the URL field updates the input value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Browse />);
    const input = screen.getByLabelText('URL or search') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'example.com');
    expect(input.value).toBe('example.com');
  });

  it('submitting a bare domain prefixes https:// in the input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Browse />);
    const input = screen.getByLabelText('URL or search') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'example.com{Enter}');
    expect(input.value).toBe('https://example.com');
  });

  it('submitting a non-URL string routes to a Google search URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Browse />);
    const input = screen.getByLabelText('URL or search') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'hello world{Enter}');
    expect(input.value).toBe('https://www.google.com/search?q=hello%20world');
  });

  it('submitting an empty string falls back to DEFAULT_BROWSE_URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Browse />);
    const input = screen.getByLabelText('URL or search') as HTMLInputElement;
    await user.clear(input);
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe(DEFAULT_BROWSE_URL);
  });

  it('reload button calls webview.reload()', () => {
    renderWithProviders(<Browse />);
    const reload = screen.getByRole('button', { name: 'Reload' });
    fireEvent.click(reload);
    expect(reloadCalls).toBe(1);
  });

  it('shows a failure banner when the webview emits did-fail-load', () => {
    renderWithProviders(<Browse />);
    const webview = findWebview();
    act(() => {
      webview.dispatchEvent(new Event('did-fail-load'));
    });
    expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
  });

  it('enables Back and Forward after a did-navigate event when history allows', () => {
    renderWithProviders(<Browse />);
    const webview = findWebview();
    canGoBackValue = true;
    canGoForwardValue = true;
    const event = new Event('did-navigate') as Event & { url?: string };
    event.url = 'https://example.org/page';
    act(() => {
      webview.dispatchEvent(event);
    });
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
    const input = screen.getByLabelText('URL or search') as HTMLInputElement;
    expect(input.value).toBe('https://example.org/page');
  });

  it('Back and Forward buttons call webview history methods', () => {
    renderWithProviders(<Browse />);
    const webview = findWebview();
    canGoBackValue = true;
    canGoForwardValue = true;
    act(() => {
      webview.dispatchEvent(new Event('did-navigate'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(backCalls).toBe(1);
    expect(forwardCalls).toBe(1);
  });

  it('clears the failure banner when a new load starts', () => {
    renderWithProviders(<Browse />);
    const webview = findWebview();
    act(() => {
      webview.dispatchEvent(new Event('did-fail-load'));
    });
    expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    act(() => {
      webview.dispatchEvent(new Event('did-start-loading'));
    });
    expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument();
  });
});
