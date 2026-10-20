import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeedbackBanner } from '@/features/terminal-component-group/components/FeedbackBanner';
import { renderWithProviders } from './test-wrapper';

function starButtons(): HTMLElement[] {
  return screen.getAllByRole('button').filter((button) => button.querySelector('.lucide-star'));
}

describe('FeedbackBanner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders rating prompt with 5 stars', () => {
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    expect(screen.getByText('How was this result?')).toBeInTheDocument();
    expect(starButtons()).toHaveLength(5);
  });

  it('star hover toggles hoveredStar', () => {
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    const stars = starButtons();
    fireEvent.mouseEnter(stars[2]);
    fireEvent.mouseLeave(stars[2]);
    expect(stars).toHaveLength(5);
  });

  it('clicking a star expands the panel and reveals form controls', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    await user.click(starButtons()[2]);
    expect(screen.getByText('Issue type (optional)')).toBeInTheDocument();
    expect(screen.getByText('Comment (optional)')).toBeInTheDocument();
    expect(screen.getByText('Submit')).toBeInTheDocument();
  });

  it('Cancel resets selected rating and collapses panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    await user.click(starButtons()[1]);
    await user.click(screen.getByText('Cancel'));
    // The details panel collapses through framer-motion's exit animation; wait for it to unmount.
    await waitFor(() => expect(screen.queryByText('Submit')).not.toBeInTheDocument());
  });

  it('submits the rating and shows the thank-you state', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    await user.click(starButtons()[4]);
    await user.type(screen.getByPlaceholderText('Additional feedback'), 'Great!');
    await user.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ rating: 5, comment: 'Great!', helpImprove: true }),
    );
    expect(await screen.findByText('Thanks for your feedback!')).toBeInTheDocument();
  });

  it('logs rejected submissions and stays in the form', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('bad'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    await user.click(starButtons()[0]);
    await user.click(screen.getByText('Submit'));
    expect(errorSpy).toHaveBeenCalled();
    expect(screen.queryByText('Thanks for your feedback!')).not.toBeInTheDocument();
    errorSpy.mockRestore();
  });

  it('enables Submit after a star is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    expect(screen.queryByText('Submit')).not.toBeInTheDocument();
    await user.click(starButtons()[0]);
    expect(await screen.findByRole('button', { name: 'Submit' })).not.toBeDisabled();
  });

  it('submits the help-improve preference', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    await user.click(starButtons()[2]);
    await user.click(screen.getByRole('checkbox', { name: /help rose improve/i }));
    await user.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ helpImprove: false }));
  });
});
