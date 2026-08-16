import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConnectedAccountChip from '@/features/integrations/components/ConnectedAccountChip';

describe('ConnectedAccountChip', () => {
  it('renders a one-line non-removable label with optional detail', () => {
    render(<ConnectedAccountChip label="Chase" detail="3 accounts" title="Chase account" />);

    const chip = screen.getByTitle('Chase account');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveTextContent('Chase / 3 accounts');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('surfaces every tone as a distinct chip state', () => {
    render(
      <div>
        <ConnectedAccountChip label="Synced" tone="synced" />
        <ConnectedAccountChip label="Syncing" tone="syncing" />
        <ConnectedAccountChip label="Warning" tone="warning" />
        <ConnectedAccountChip label="Error" tone="error" />
        <ConnectedAccountChip label="Neutral" tone="neutral" />
      </div>,
    );

    expect(screen.getByText('Synced').parentElement).toHaveClass('bg-rose-500/10');
    expect(screen.getByText('Syncing').parentElement).toHaveClass('bg-sky-500/10');
    expect(screen.getByText('Warning').parentElement).toHaveClass('bg-amber-500/10');
    expect(screen.getByText('Error').parentElement).toHaveClass('bg-destructive/10');
    expect(screen.getByText('Neutral').parentElement).toHaveClass('bg-muted/50');
  });

  it('shows the always-visible remove affordance and calls the remove handler', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ConnectedAccountChip
        label="user@gmail.com"
        onRemove={onRemove}
        removeLabel="Disconnect user@gmail.com"
      />,
    );

    const chip = screen.getByRole('button', { name: 'Disconnect user@gmail.com' });
    expect(chip).toHaveTextContent('user@gmail.com');

    await user.click(chip);

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('disables removal and shows a spinner while removing', () => {
    render(
      <ConnectedAccountChip
        label="Chase"
        onRemove={() => {}}
        removeLabel="Disconnect Chase"
        removing={true}
      />,
    );

    const chip = screen.getByRole('button', { name: 'Disconnect Chase' });
    expect(chip).toBeDisabled();
    expect(chip.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
