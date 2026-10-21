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
  document.documentElement.className = '';
});
describe('login dark mode hook', () => {
  it('smoothly changes to dark once on login, keeps manual choice until next login, and cleans up', () => {
    vi.useFakeTimers();
    localStorage.setItem('rose-theme:viewer', 'light');
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
    expect(document.documentElement).toHaveClass('dark');
    view.unmount();
    expect(document.documentElement).not.toHaveClass('dark', 'rose-login-theme-transition');
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
