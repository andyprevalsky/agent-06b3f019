import { it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import Terminal from '@/pages/Terminal';

// Exercise the homepage renderer that owns the opening animation.
vi.mock('@/lib/roseDesktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/roseDesktop')>()),
  isRoseDesktopUser: () => false,
}));

it('centers desktop ASCII independently of the opening caption height', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  renderWithProviders(<Terminal />);

  const art = await screen.findByTestId('terminal-opening-ascii-transform');
  const caption = await screen.findByTestId('terminal-opening-caption-slot');
  // The flex-centered box must size to the art alone. An in-flow caption
  // lifts the art by half the caption height + gap, away from the grid center.
  expect(art.parentElement).toHaveClass('md:relative', 'md:mb-[20vh]');
  expect(caption).toHaveClass('md:absolute', 'md:left-1/2', 'md:top-full', 'md:-translate-x-1/2');
});
