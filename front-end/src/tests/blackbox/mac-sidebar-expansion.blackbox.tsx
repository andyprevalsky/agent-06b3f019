import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { defaultProps } from './app-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

afterEach(() => vi.unstubAllGlobals());

describe('Mac sidebar hover latch', () => {
  it('stays open after leaving and collapses at any height on the far-left edge', () => {
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
    fireEvent.mouseMove(window, { clientX: 2, clientY: 700 });
    expect(bar).toHaveAttribute('data-expanded', 'false');
    fireEvent.mouseEnter(bar);
    expect(bar).toHaveAttribute('data-expanded', 'true');
    fireEvent.mouseMove(window, { clientX: 0, clientY: 20 });
    expect(bar).toHaveAttribute('data-expanded', 'false');
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
