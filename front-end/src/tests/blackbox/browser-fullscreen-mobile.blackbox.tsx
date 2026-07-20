/**
 * Blackbox tests for the mobile fullscreen browser layout.
 *
 * Desktop keeps the horizontal split (fixed-width task-progress panel beside
 * the iframe). On mobile that fixed 320px column would clip the live iframe to
 * a sliver, so it must NOT render inline — the iframe pane takes the full
 * width and the task progress is reachable behind a header toggle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';

// Control the mobile breakpoint deterministically.
const mobileState = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mobileState.value,
}));

// Stub heavy children so the test isolates layout, not realtime/canvas work.
vi.mock('@/features/terminal-component-group/components/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => null,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => null,
}));

import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen';

const DESKTOP_PANEL_CLASS = 'w-[min(320px,calc(100vw-60px))]';

type Props = React.ComponentProps<typeof BrowserStatusBarFullscreen>;

function defaultProps(overrides: Partial<Props> = {}): Props {
  return {
    agentId: 'agent-1',
    taskId: 't1',
    browserUrl: 'https://example.com',
    messages: [],
    outputSchema: undefined,
    browserSessionMetadata: null,
    stepProgress: null,
    isDisconnected: false,
    isWaitingForAuthAssistance: false,
    authAssistanceRequest: undefined,
    isResuming: false,
    pendingWriteLockApproval: null,
    onClose: vi.fn(),
    onResume: vi.fn(),
    ...overrides,
  };
}

describe('BrowserStatusBarFullscreen mobile layout', () => {
  beforeEach(() => {
    mobileState.value = false;
  });

  it('renders the fixed-width task-progress panel on desktop', () => {
    mobileState.value = false;
    renderWithProviders(<BrowserStatusBarFullscreen {...defaultProps()} />);

    expect(screen.getByText('Task progress')).toBeInTheDocument();
    expect(document.body.innerHTML).toContain(DESKTOP_PANEL_CLASS);
    // No mobile toggle on desktop.
    expect(screen.queryByLabelText('Show task progress')).not.toBeInTheDocument();
  });

  it('drops the fixed-width panel on mobile so the iframe pane is full-width', () => {
    mobileState.value = true;
    renderWithProviders(<BrowserStatusBarFullscreen {...defaultProps()} />);

    // The 320px desktop column must not render inline on mobile.
    expect(screen.queryByText('Task progress')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(DESKTOP_PANEL_CLASS);

    // Iframe still present and full-width.
    const iframe = screen.getByTitle('Browser');
    expect(iframe).toHaveClass('w-full', 'h-full');

    // Progress is reachable behind a toggle.
    expect(screen.getByLabelText('Show task progress')).toBeInTheDocument();
  });

  it('opens the task progress as an overlay when the mobile toggle is tapped', async () => {
    const u = userEvent.setup();
    mobileState.value = true;
    renderWithProviders(<BrowserStatusBarFullscreen {...defaultProps()} />);

    await u.click(screen.getByLabelText('Show task progress'));

    expect(await screen.findByText('Task progress')).toBeInTheDocument();
    const closeButton = screen.getByLabelText('Close task progress');
    await u.click(closeButton);
    await waitFor(() => {
      expect(screen.queryByText('Task progress')).not.toBeInTheDocument();
    });
  });
});
