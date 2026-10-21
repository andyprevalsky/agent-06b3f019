import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { defaultProps } from './app-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

afterEach(() => vi.unstubAllGlobals());

describe('Mac sidebar hover latch', () => {
  it('stays open after leaving and collapses in the left18% at any height', () => {
    vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: 'MacIntel' } }));
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    const bar = screen.getByTestId('rose-sidebar');
    fireEvent.mouseEnter(bar);
    expect(bar).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByTestId('sidebar-collapse-hint')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('sidebar-collapse-hint').querySelector('button')).toBeNull();
    fireEvent.mouseLeave(bar);
    fireEvent.mouseMove(window, { clientX: 400, clientY: 500 });
    expect(bar).toHaveAttribute('data-expanded', 'true');
    fireEvent.mouseMove(window, { clientX: window.innerWidth * 0.17, clientY: 700 });
    expect(bar).toHaveAttribute('data-expanded', 'false');
    fireEvent.mouseEnter(bar);
    expect(bar).toHaveAttribute('data-expanded', 'false');
    fireEvent.mouseMove(window, { clientX: window.innerWidth * 0.3, clientY: 20 });
    fireEvent.mouseEnter(bar);
    expect(bar).toHaveAttribute('data-expanded', 'true');
    fireEvent.mouseMove(bar, { clientX: 30, clientY: 20 });
    expect(bar).toHaveAttribute('data-expanded', 'true');
    fireEvent.mouseLeave(bar);
    fireEvent.mouseMove(window, { clientX: 0, clientY: 20 });
    expect(bar).toHaveAttribute('data-expanded', 'false');
  });

  it('keeps sidebar controls usable and closes with a leftward drag', () => {
    vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: 'MacIntel' } }));
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    const bar = screen.getByTestId('rose-sidebar');
    fireEvent.mouseEnter(bar);
    fireEvent.mouseMove(screen.getByRole('button', { name: 'Home' }), { clientX: 100 });
    expect(bar).toHaveAttribute('data-expanded', 'true');
    const pointer = (target: EventTarget, type: string, x: number) => {
      const e = new Event(type, { bubbles: true });
      Object.defineProperties(e, { clientX: { value: x }, button: { value: 0 } });
      fireEvent(target as HTMLElement, e);
    };
    pointer(bar, 'pointerdown', 200);
    pointer(window, 'pointermove', 170);
    expect(bar).toHaveAttribute('data-expanded', 'true');
    pointer(window, 'pointermove', 140);
    expect(bar).toHaveAttribute('data-expanded', 'false');
    pointer(window, 'pointerup', 140);
  });

  it('preserves ordinary hover collapse outside Mac', () => {
    vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: 'Linux x86_64' } }));
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    const bar = screen.getByTestId('rose-sidebar');
    fireEvent.mouseEnter(bar);
    expect(bar).toHaveAttribute('data-expanded', 'true');
    expect(screen.queryByTestId('sidebar-collapse-hint')).toBeNull();
    fireEvent.mouseLeave(bar);
    expect(bar).toHaveAttribute('data-expanded', 'false');
  });
});
