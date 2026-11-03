import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { defaultProps } from './app-sidebar.fixtures';
import { createAgentButton } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

afterEach(() => vi.unstubAllGlobals());

describe('Mac sidebar hover and explicit close', () => {
  it.each([768, 1280, 1920])(
    'ignores edge movement at %ipx and closes only through the back button',
    (width) => {
      vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: 'MacIntel' } }));
      vi.stubGlobal('innerWidth', width);
      const create = vi.fn();
      renderWithProviders(<AppSidebar {...defaultProps({ onCreateAgent: create })} />);
      const bar = screen.getByTestId('rose-sidebar');
      for (let repeat = 0; repeat < 3; repeat++) {
        fireEvent.mouseEnter(bar);
        expect(bar).toHaveAttribute('data-expanded', 'true');
        fireEvent.mouseLeave(bar, { clientX: 240 });
        fireEvent.mouseMove(window, { clientX: width * 0.17 });
        fireEvent.mouseMove(window, { clientX: 0 });
        fireEvent.mouseEnter(bar);
        expect(bar).toHaveAttribute('data-expanded', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(bar).toHaveAttribute('data-expanded', 'false');
        expect(create).not.toHaveBeenCalled();
        fireEvent.mouseEnter(bar);
        expect(bar).toHaveAttribute('data-expanded', 'false');
        fireEvent.mouseLeave(bar);
      }
      fireEvent.mouseEnter(bar);
      expect(bar).toHaveAttribute('data-expanded', 'true');
      fireEvent.click(createAgentButton('home'));
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it.each([768, 1280, 1920])(
    'closes beyond the right edge plus 10%% of the %ipx window, without a left bumper',
    (width) => {
      vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: 'MacIntel' } }));
      vi.stubGlobal('innerWidth', width);
      renderWithProviders(<AppSidebar {...defaultProps()} />);
      const bar = screen.getByTestId('rose-sidebar');
      fireEvent.mouseEnter(bar);
      const boundary = 236 + width * 0.1;
      fireEvent.mouseMove(window, { clientX: boundary });
      expect(bar).toHaveAttribute('data-expanded', 'true');
      fireEvent.mouseMove(window, { clientX: 0 });
      expect(bar).toHaveAttribute('data-expanded', 'true');
      fireEvent.mouseMove(window, { clientX: boundary + 1 });
      expect(bar).toHaveAttribute('data-expanded', 'false');
      fireEvent.mouseEnter(bar);
      expect(bar).toHaveAttribute('data-expanded', 'true');
    },
  );

  it('preserves ordinary hover collapse outside Mac', () => {
    vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: 'Linux x86_64' } }));
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    const bar = screen.getByTestId('rose-sidebar');
    fireEvent.mouseEnter(bar);
    expect(bar).toHaveAttribute('data-expanded', 'true');
    fireEvent.mouseLeave(bar);
    expect(bar).toHaveAttribute('data-expanded', 'false');
  });
});
