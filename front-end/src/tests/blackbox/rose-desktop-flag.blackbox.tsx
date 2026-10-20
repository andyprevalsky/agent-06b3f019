/**
 * Rose Desktop feature flag (lib/roseDesktop.ts): the new chrome is on only for
 * flagged accounts; every other account keeps the stock UI.
 */
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import { PopularGoalsCarousel } from '@/features/terminal/components/PopularGoalsCarousel';
import { POPULAR_GOALS, ROSE_DESKTOP_POPULAR_GOALS } from '@/features/terminal/config';
import { ROSE_DESKTOP_USER_IDS, isRoseDesktopUser } from '@/lib/roseDesktop';

import { renderWithProviders } from './test-wrapper';

const ANDY = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const queryProps = {
  value: '',
  onChange: vi.fn(),
  onSubmit: vi.fn(),
  selectedModel: 'rose-labs/rose-1-flash',
  availableModels: [
    { id: 'rose-labs/rose-1-flash', name: 'rose-fast', provider: 'rose-labs', description: 'fast' },
  ],
};

function renderGoals(roseDesktop: boolean) {
  return renderWithProviders(
    <PopularGoalsCarousel
      tickerOffset={0}
      tickerRef={createRef<HTMLDivElement>()}
      onGoalClick={vi.fn()}
      dripStyles={{} as never}
      borderColor={0}
    />,
    { roseDesktop },
  );
}

describe('Rose Desktop flag', () => {
  it('is on only for the allowlisted account', () => {
    expect(ROSE_DESKTOP_USER_IDS).toEqual([ANDY]);
    expect(isRoseDesktopUser({ id: ANDY })).toBe(true);
    expect(isRoseDesktopUser({ id: '8283e892-b0a4-4298-9ef7-b95bcc67e46b' })).toBe(false);
    expect(isRoseDesktopUser({ id: '' })).toBe(false);
    expect(isRoseDesktopUser(null)).toBe(false);
    expect(isRoseDesktopUser(undefined)).toBe(false);
  });

  it('stock UI keeps the query toolbar visible with no nub', () => {
    renderWithProviders(<QueryInput {...queryProps} />, { roseDesktop: false });
    expect(screen.queryByTestId('query-toolbar-region')).not.toBeInTheDocument();
    expect(screen.queryByTestId('query-toolbar-nub')).not.toBeInTheDocument();
  });

  it('Rose Desktop hides the query toolbar behind the nub', () => {
    renderWithProviders(<QueryInput {...queryProps} />, { roseDesktop: true });
    expect(screen.getByTestId('query-toolbar-nub')).toBeInTheDocument();
    expect(screen.getByTestId('query-toolbar-region')).toHaveAttribute('data-state', 'closed');
  });

  it('new popular goals appear only with the flag, first in the rotation', () => {
    const { unmount } = renderGoals(false);
    for (const goal of ROSE_DESKTOP_POPULAR_GOALS) {
      expect(screen.queryByText(goal)).not.toBeInTheDocument();
    }
    expect(screen.getAllByText(POPULAR_GOALS[0]).length).toBeGreaterThan(0);
    unmount();

    renderGoals(true);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent(ROSE_DESKTOP_POPULAR_GOALS[0]);
  });
});
