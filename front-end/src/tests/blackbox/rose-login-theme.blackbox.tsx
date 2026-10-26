import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoseThemeProvider, useRoseTheme } from '@/features/rose-theme';
import { renderWithProviders } from './test-wrapper';
export function Theme() {
  const { isDark, toggle } = useRoseTheme();
  return (
    <button data-testid="login-theme" data-dark={isDark} onClick={toggle}>
      Toggle
    </button>
  );
}
function ui(userId: string | null) {
  return (
    <RoseThemeProvider userId={userId} darkOnLogin>
      <Theme />
    </RoseThemeProvider>
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const cookie of document.cookie.split(';')) {
    const key = cookie.trim().split('=')[0];
    if (key.startsWith('rose-theme')) document.cookie = `${key}=; Max-Age=0; Path=/`;
  }
  document.documentElement.className = '';
});
describe('login dark mode hook', () => {
  it('eases manual theme changes in both directions and cleans up after rapid toggles', () => {
    vi.useFakeTimers();
    const view = renderWithProviders(
      <RoseThemeProvider userId="manual">
        <Theme />
      </RoseThemeProvider>,
    );
    const toggle = screen.getByTestId('login-theme');
    fireEvent.click(toggle);
    expect(document.documentElement).toHaveClass('dark', 'rose-login-theme-transition');
    act(() => {
      vi.advanceTimersByTime(240);
    });
    fireEvent.click(toggle);
    expect(document.documentElement).not.toHaveClass('dark');
    act(() => {
      vi.advanceTimersByTime(240);
    });
    expect(document.documentElement).toHaveClass('rose-login-theme-transition');
    act(() => {
      vi.advanceTimersByTime(240);
    });
    expect(document.documentElement).not.toHaveClass('rose-login-theme-transition');
    fireEvent.click(toggle);
    view.unmount();
    expect(document.documentElement).not.toHaveClass('rose-login-theme-transition');
  });

  it('smoothly changes to dark once on login, remembers manual choice on the next login, and cleans up', () => {
    vi.useFakeTimers();
    const view = renderWithProviders(ui(null));
    expect(screen.getByTestId('login-theme')).toHaveAttribute('data-dark', 'false');
    view.rerender(ui('viewer'));
    expect(document.documentElement).toHaveClass('rose-login-theme-transition');
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('rose-theme:viewer')).toBe('dark');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.documentElement).not.toHaveClass('rose-login-theme-transition');
    fireEvent.click(screen.getByTestId('login-theme'));
    view.rerender(ui('viewer'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('login-theme')).toHaveAttribute('data-dark', 'false');
    view.rerender(ui(null));
    view.rerender(ui('viewer'));
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(document.documentElement).not.toHaveClass('dark');
    view.unmount();
    expect(document.documentElement).not.toHaveClass('dark', 'rose-login-theme-transition');
  });
  it('remembers both light and dark from cookies after remount and storage loss, scoped per account', () => {
    vi.useFakeTimers();
    const view = renderWithProviders(ui('cookie-viewer'));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(document.documentElement).toHaveClass('dark');
    expect(document.cookie).toContain('rose-theme%3Acookie-viewer=dark');
    fireEvent.click(screen.getByTestId('login-theme'));
    expect(document.cookie).toContain('rose-theme%3Acookie-viewer=light');
    view.unmount();
    localStorage.clear();
    const restored = renderWithProviders(ui('cookie-viewer'));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('rose-theme:cookie-viewer')).toBe('light');
    fireEvent.click(screen.getByTestId('login-theme'));
    restored.unmount();
    localStorage.clear();
    const dark = renderWithProviders(ui('cookie-viewer'));
    expect(document.documentElement).toHaveClass('dark');
    dark.unmount();
    renderWithProviders(ui('other-viewer'));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('honors reduced motion and switches immediately without transition', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
      matches: media === '(prefers-reduced-motion: reduce)',
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => false,
      onchange: null,
    }));
    renderWithProviders(ui('reduced'));
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('rose-login-theme-transition');
  });
  it('does not change public or rollout-disabled views and cancels a pending login on logout', () => {
    vi.useFakeTimers();
    const view = renderWithProviders(ui('viewer'));
    view.rerender(ui(null));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.documentElement).not.toHaveClass('dark', 'rose-login-theme-transition');
    view.unmount();
    renderWithProviders(ui('disabled'), { roseDesktop: false });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('rose-theme:disabled')).toBeNull();
  });
});
