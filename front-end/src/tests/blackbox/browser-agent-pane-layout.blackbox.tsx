/**
 * Blackbox tests for the Browser drawer's agent pane layout (it replaced the
 * fullscreen browser view).
 *
 * Both form factors stack: status row, full-width 8:5 live browser, then the
 * always-visible task progress. Desktop overlays agent controls on the live
 * view; mobile (bottom sheet) moves them to a footer below it. The remote
 * viewport remains desktop-sized and scales into the aspect-matched pane.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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

import { BrowserAgentPane } from '@/features/terminal-component-group/components/browser-status-bar/BrowserAgentPane';

type Props = React.ComponentProps<typeof BrowserAgentPane>;

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
    isUserControlling: false,
    pendingWriteLockApproval: null,
    onResume: vi.fn(),
    ...overrides,
  };
}

describe('BrowserAgentPane layout', () => {
  beforeEach(() => {
    mobileState.value = false;
  });

  it('stacks the letterboxed live view above full-width task progress on desktop', () => {
    mobileState.value = false;
    renderWithProviders(<BrowserAgentPane {...defaultProps()} />);

    expect(screen.getByText('Task progress')).toBeInTheDocument();
    const panel = screen.getByTestId('task-progress-panel');
    expect(panel).toHaveClass('w-full');
    // The old fixed-width fullscreen side column is gone.
    expect(document.body.innerHTML).not.toContain('w-[min(320px,calc(100vw-60px))]');
    const livePane = screen.getByTestId('live-view-pane');
    expect(livePane).toHaveStyle({ aspectRatio: '8 / 5' });
    expect(livePane.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Desktop overlays the take-control chip on the live view (no footer).
    expect(livePane).toContainElement(screen.getByRole('button', { name: 'Take control' }));
    expect(screen.queryByTestId('mobile-browser-control-footer')).not.toBeInTheDocument();
  });

  it('prioritizes disconnected controls when desktop auth assistance is also pending', () => {
    mobileState.value = false;
    renderWithProviders(
      <BrowserAgentPane
        {...defaultProps({
          isDisconnected: true,
          isWaitingForAuthAssistance: true,
          authAssistanceRequest: 'Please sign in',
        })}
      />,
    );

    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take Control' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Agent' })).not.toBeInTheDocument();
  });

  it('stacks a full-width browser above always-visible progress on mobile', () => {
    mobileState.value = true;
    renderWithProviders(<BrowserAgentPane {...defaultProps()} />);

    // The desktop stream fills an aspect-matched, full-width mobile pane.
    const iframe = screen.getByTitle('Browser');
    expect(iframe).toHaveClass('w-full', 'h-full');
    const browserPane = iframe.parentElement?.parentElement;
    expect(browserPane).toHaveClass('w-full', 'flex-none', 'overflow-hidden');
    expect(browserPane).toHaveStyle({ aspectRatio: '8 / 5' });

    // Agent controls are a footer below the image, never an overlay obscuring it.
    const takeControl = screen.getByRole('button', { name: 'Take control' });
    const controlFooter = takeControl.closest('[data-testid="mobile-browser-control-footer"]');
    expect(controlFooter).toBeInTheDocument();
    expect(browserPane).not.toContainElement(takeControl);
    expect(controlFooter?.previousElementSibling).toBe(browserPane);

    // Progress is part of the same view, not hidden behind tabs or a toggle.
    expect(screen.getByText('Task progress')).toBeInTheDocument();
    expect(screen.queryByText('Live browser')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Browser' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Progress' })).not.toBeInTheDocument();
    expect(screen.queryByText(/handle logins or captchas/i)).not.toBeInTheDocument();
  });

  it('keeps disconnected controls internally consistent when auth assistance is also pending', () => {
    mobileState.value = true;
    renderWithProviders(
      <BrowserAgentPane
        {...defaultProps({
          isDisconnected: true,
          isWaitingForAuthAssistance: true,
          authAssistanceRequest: 'Please sign in',
        })}
      />,
    );

    const footer = screen.getByTestId('mobile-browser-control-footer');
    expect(footer).toHaveTextContent('Browser disconnected');
    expect(screen.getByRole('button', { name: 'Take control' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Agent' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('thinking-animation')).not.toBeInTheDocument();
  });

  it('flips between take-control and hand-back states on mobile', async () => {
    mobileState.value = true;
    function ControlHarness() {
      const [controlled, setControlled] = useState(false);
      return (
        <BrowserAgentPane
          {...defaultProps({
            isUserControlling: controlled,
            onResume: () => setControlled((current) => !current),
          })}
        />
      );
    }
    const user = userEvent.setup();
    renderWithProviders(<ControlHarness />);

    await user.click(screen.getByRole('button', { name: 'Take control' }));
    expect(screen.getAllByText('You have control')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Hand back control' }));
    expect(screen.getByRole('button', { name: 'Take control' })).toBeInTheDocument();
  });
});
