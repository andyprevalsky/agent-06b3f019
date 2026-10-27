/** Browser selector behavior, preserving mounted task owners across selection. */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import RawBrowserStatusBarCarousel from '@/features/terminal-component-group/components/BrowserStatusBarCarousel';
import { AgentContext } from '@/features/agent-context';
import { makeAgentCtx } from './message-bubble.fixtures';
vi.mock('@/features/terminal-component-group/components/BrowserStatusBar', () => ({
  default: ({
    taskId,
    browserUrl,
    forceMinimized,
  }: {
    taskId: string;
    browserUrl: string;
    forceMinimized?: boolean;
  }) => (
    <div
      data-testid={`browser-status-bar-${taskId}`}
      data-url={browserUrl}
      data-force-minimized={String(!!forceMinimized)}
    >
      browser-{taskId}
    </div>
  ),
}));

export function BrowserStatusBarCarousel({
  browsers,
}: {
  browsers: { taskId: string; browserUrl: string }[];
}) {
  const messages = browsers.flatMap((browser) => [
    {
      message_id: `spawn-${browser.taskId}`,
      timestamp: '2026-10-27T00:00:00Z',
      role: 'TOOL' as const,
      text: '',
      metadata: { toolCallId: browser.taskId, backgroundPath: `/root/browser_${browser.taskId}` },
    },
    {
      message_id: `init-${browser.taskId}`,
      timestamp: '2026-10-27T00:01:00Z',
      role: 'TOOL' as const,
      text: '',
      metadata: { toolCallId: browser.taskId, task_id: browser.taskId, action_type: 'browser' },
    },
  ]);
  return (
    <AgentContext.Provider value={makeAgentCtx({ messages })}>
      <RawBrowserStatusBarCarousel browsers={browsers} />
    </AgentContext.Provider>
  );
}

describe('BrowserStatusBarCarousel', () => {
  it('returns null when no browsers given', () => {
    const { container } = renderWithProviders(<BrowserStatusBarCarousel browsers={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a single browser without carousel controls', () => {
    renderWithProviders(
      <BrowserStatusBarCarousel browsers={[{ taskId: 't1', browserUrl: 'https://x.com' }]} />,
    );
    expect(screen.getByTestId('browser-status-bar-t1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Previous browser')).not.toBeInTheDocument();
  });

  it('renders every browser as a named selector with a count', () => {
    renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
          { taskId: 't3', browserUrl: 'https://z.com' },
        ]}
      />,
    );
    expect(screen.getAllByRole('button', { name: /Show browser:/ })).toHaveLength(3);
    expect(screen.getByText('3 browsers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show browser: Browser t1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('selects each browser by its name', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
        ]}
      />,
    );
    expect(screen.getByTestId('browser-status-bar-t1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show browser: Browser t2' }));
    expect(screen.getByTestId('browser-status-bar-t2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show browser: Browser t1' }));
    expect(screen.getByTestId('browser-status-bar-t1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show browser: Browser t2' }));
    expect(screen.getByTestId('browser-status-bar-t2')).toBeVisible();
  });

  it('selecting a browser hides the inactive card', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
        ]}
      />,
    );
    expect(screen.getByTestId('browser-status-bar-t1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show browser: Browser t2' }));
    expect(screen.getByTestId('browser-status-bar-t1')).not.toBeVisible();
    expect(screen.getByTestId('browser-status-bar-t2')).toBeVisible();
  });

  it('shrinks browsers array to the surviving task', () => {
    const { rerender } = renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
          { taskId: 't3', browserUrl: 'https://z.com' },
        ]}
      />,
    );
    // Reduce to 1 → single browser path
    rerender(
      <BrowserStatusBarCarousel browsers={[{ taskId: 't1', browserUrl: 'https://x.com' }]} />,
    );
    expect(screen.getByTestId('browser-status-bar-t1')).toBeInTheDocument();
  });
});
