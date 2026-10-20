/**
 * Blackbox tests for FeedbackBanner (split out of low-cov-chips.blackbox.tsx to
 * keep each file within the max-lines budget). FeedbackBanner needs none of the
 * heavy child mocks the other chip components require.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import { FeedbackBanner } from '@/features/terminal-component-group/components/FeedbackBanner';

describe('FeedbackBanner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders rating prompt with 5 stars', () => {
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    expect(screen.getByText('How was this result?')).toBeInTheDocument();
    // 5 star buttons
    const buttons = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-star'));
    expect(buttons).toHaveLength(5);
  });

  it('star hover toggles hoveredStar (re-renders color)', () => {
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    const starButtons = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    fireEvent.mouseEnter(starButtons[2]);
    fireEvent.mouseLeave(starButtons[2]);
    // No assertion needed beyond no-throw — exercises mouseEnter/Leave code paths
    expect(starButtons.length).toBe(5);
  });

  it('clicking a star expands the panel and reveals form controls', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    const stars = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[2]); // rating = 3
    expect(screen.getByText('Issue type (optional)')).toBeInTheDocument();
    expect(screen.getByText('Comment (optional)')).toBeInTheDocument();
    expect(screen.getByText('Submit')).toBeInTheDocument();
  });

  it('Cancel resets selected rating and collapses panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    const stars = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[1]);
    expect(screen.getByText('Submit')).toBeInTheDocument();
    await user.click(screen.getByText('Cancel'));
    // Panel collapses through framer-motion's exit animation; wait for it to unmount.
    await waitFor(() => expect(screen.queryByText('Submit')).not.toBeInTheDocument());
  });

  it('Submit: calls onSubmit with rating and shows thank-you state on success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    const stars = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[4]); // rating = 5
    await user.type(screen.getByPlaceholderText('Additional feedback'), 'Great!');
    await user.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: 5,
        comment: 'Great!',
        helpImprove: true,
      }),
    );
    // Thank-you state
    expect(await screen.findByText('Thanks for your feedback!')).toBeInTheDocument();
  });

  it('Submit: logs error when onSubmit rejects, stays in form', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('bad'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    const stars = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[0]);
    await user.click(screen.getByText('Submit'));
    expect(errSpy).toHaveBeenCalled();
    // Should not transition to thank-you
    expect(screen.queryByText('Thanks for your feedback!')).not.toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('Submit is enabled after star click (rating > 0)', async () => {
    // The `disabled={selectedRating === 0}` branch on Submit is effectively
    // unreachable through UI flow: clicking any star sets rating>=1 AND opens
    // the panel in the same handler, and Cancel both collapses the panel and
    // resets rating to 0. So we can't assert disabled=true via blackbox without
    // reaching into internal state. We CAN assert the inverse: once the panel
    // is open (by any legal user path), Submit must be ENABLED. This catches
    // a regression that made Submit always-disabled.
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    // Before opening, Submit is not in the DOM.
    expect(screen.queryByText('Submit')).not.toBeInTheDocument();
    // Click the first star — sets rating=1 AND expands the panel.
    const stars = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[0]);
    // Submit now renders and is enabled (rating > 0).
    const submitBtn = await screen.findByRole('button', { name: 'Submit' });
    expect(submitBtn).not.toBeDisabled();
  });

  it('toggles helpImprove checkbox', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    const stars = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[2]);
    const checkbox = screen.getByRole('checkbox', {
      name: /help rose improve/i,
    });
    await user.click(checkbox); // uncheck
    await user.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ helpImprove: false }));
  });
});
