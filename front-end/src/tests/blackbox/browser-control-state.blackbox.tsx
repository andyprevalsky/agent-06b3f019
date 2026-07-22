/**
 * Blackbox coverage for browser-control state priority shared by inline and
 * fullscreen browser surfaces.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => <div data-testid="browser-border-glow" />,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => <div data-testid="browser-cursor-overlay" />,
}));

import { BrowserIframe } from '@/features/terminal-component-group/components/browser-view-panel/BrowserIframe';

describe('browser control state', () => {
  it('prioritizes disconnected over pending auth assistance in the inline browser', () => {
    renderWithProviders(
      <BrowserIframe
        agentId="agent-1"
        taskId="task-1"
        url="https://example.com"
        messages={[]}
        isFullscreen={false}
        isDisconnected
        isWaitingForAuthAssistance
        isResuming={false}
        onResume={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Take Control' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Agent' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-border-glow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-cursor-overlay')).not.toBeInTheDocument();
  });
});
