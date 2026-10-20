import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AsciiLoader from '@/features/terminal-component-group/components/AsciiLoader';
import { renderWithProviders } from './test-wrapper';

describe('AsciiLoader CTA contrast', () => {
  it('renders a dark label on a solid white waitlist button without dark layers', () => {
    renderWithProviders(
      <AsciiLoader
        showWarmingUp={false}
        size="large"
        variant="engine"
        cta={{ label: 'Join Waitlist', onClick: vi.fn() }}
      />,
    );

    const button = screen.getByTestId('opening-join-waitlist');
    const label = screen.getByTestId('opening-join-label') as HTMLElement;
    const darkBackgroundLayers = Array.from(button.children).filter(
      (child) =>
        child instanceof HTMLElement &&
        child.style.background.replaceAll(' ', '').includes('rgba(0,0,0'),
    );

    expect(label.style.textShadow).toBe('');
    expect(button.className).toContain('bg-white');
    expect(darkBackgroundLayers).toHaveLength(0);
  });
});
