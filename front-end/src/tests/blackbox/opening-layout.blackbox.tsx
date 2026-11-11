import { it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import Terminal from '@/pages/Terminal';

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

it('anchors the desktop opening loader to the viewport rather than the sidebar-inset chat', async () => {
  const user = { id: 'layout-test', is_anonymous: false };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'layout-test',
      refresh_token: 'layout-test',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
  renderWithProviders(<Terminal />);
  expect(await screen.findByTestId('terminal-main-content')).toHaveClass('md:pl-[64px]');
  expect(await screen.findByTestId('terminal-opening-loader')).toHaveClass(
    'absolute',
    'md:fixed',
    'md:inset-0',
  );
});

it('keeps the desktop caption at its November 3 reference position', async () => {
  renderWithProviders(<Terminal />);
  expect(await screen.findByTestId('terminal-opening-caption-slot')).toHaveClass(
    'md:!mt-3',
    'md:-translate-y-1/2',
  );
});
