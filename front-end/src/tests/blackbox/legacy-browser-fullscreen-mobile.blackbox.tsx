/**
 * Blackbox tests for the mobile fullscreen browser layout.
 *
 * Desktop keeps the horizontal split (fixed-width task-progress panel beside
 * the iframe). Mobile is one stacked view: fixed header, full-width 8:5 live
 * browser, browser-control footer, then always-visible task progress. The
 * remote viewport remains desktop-sized and scales into the aspect-matched
 * browser pane.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { renderWithProviders as renderWithFlaggedProviders } from './test-wrapper';

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

import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/legacy/BrowserStatusBarFullscreen';

/** Stock UI (Rose Desktop flag off): accounts without the flag keep the pre–Rose Desktop browser and toolbar. */
const renderWithProviders: typeof renderWithFlaggedProviders = (ui, options) =>
  renderWithFlaggedProviders(ui, { ...options, roseDesktop: false });

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
    isUserControlling: false,
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
  });

  it('prioritizes disconnected controls when desktop auth assistance is also pending', () => {
    mobileState.value = false;
    renderWithProviders(
      <BrowserStatusBarFullscreen
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
    renderWithProviders(<BrowserStatusBarFullscreen {...defaultProps()} />);

    // The fixed-width desktop column must not render inline on mobile.
    expect(document.body.innerHTML).not.toContain(DESKTOP_PANEL_CLASS);

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
      <BrowserStatusBarFullscreen
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
        <BrowserStatusBarFullscreen
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
