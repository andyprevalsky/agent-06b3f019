import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AsciiLoader from '@/features/terminal-component-group/components/AsciiLoader';
import { renderWithProviders } from './test-wrapper';

describe('AsciiLoader CTA contrast', () => {
  it('keeps the label shadow without darkening the whole waitlist button', () => {
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

    expect(label.style.textShadow).toMatch(/rgba?\(0,\s*0,\s*0/);
    expect(darkBackgroundLayers).toHaveLength(0);
  });
});
