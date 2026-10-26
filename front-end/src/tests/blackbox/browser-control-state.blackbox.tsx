/**
 * Blackbox coverage for browser-control state priority on the live browser
 * surface (BrowserAgentPane, portaled by BrowserStatusBar into the Browser drawer).
 */
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));
vi.mock('@/features/terminal-component-group/components/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => <div data-testid="browser-border-glow" />,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => <div data-testid="browser-cursor-overlay" />,
}));

import { BrowserAgentPane } from '@/features/terminal-component-group/components/browser-status-bar/BrowserAgentPane';

const browserUseUrl = 'https://live.browser-use.com/session/browser-use-test';

function fullscreen(overrides: { isDisconnected?: boolean; isWaitingForAuthAssistance?: boolean }) {
  return (
    <BrowserAgentPane
      agentId="agent-1"
      taskId="task-1"
      browserUrl={browserUseUrl}
      messages={[]}
      outputSchema={undefined}
      browserSessionMetadata={null}
      stepProgress={null}
      isDisconnected={overrides.isDisconnected ?? false}
      isWaitingForAuthAssistance={overrides.isWaitingForAuthAssistance ?? false}
      isResuming={false}
      isUserControlling={false}
      pendingWriteLockApproval={null}
      onResume={vi.fn()}
    />
  );
}

describe('browser control state', () => {
  it('keeps the Browser Use viewer inert while the agent owns control', () => {
    renderWithProviders(fullscreen({}));
    const viewer = screen.getByTitle('Browser');
    expect(viewer).toHaveAttribute('inert');
    expect(viewer).toHaveAttribute('tabindex', '-1');
    expect(viewer).toHaveClass('pointer-events-none');
  });

  it('exposes the Browser Use viewer during sign-in handoff', () => {
    renderWithProviders(fullscreen({ isWaitingForAuthAssistance: true }));
    const viewer = screen.getByTitle('Browser');
    expect(viewer).not.toHaveAttribute('inert');
    expect(viewer).not.toHaveClass('pointer-events-none');
    expect(screen.getByRole('button', { name: 'Start Agent' }).parentElement).not.toHaveClass(
      'inset-0',
    );
  });

  it('prioritizes disconnected over pending auth assistance', () => {
    renderWithProviders(fullscreen({ isDisconnected: true, isWaitingForAuthAssistance: true }));

    expect(screen.getByRole('button', { name: 'Take Control' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Agent' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-border-glow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-cursor-overlay')).not.toBeInTheDocument();
  });
});
