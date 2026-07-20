/**
 * Blackbox tests for TerminalHeader responsive auth actions.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { renderWithProviders } from './test-wrapper';

import { TerminalHeader } from '@/features/terminal/components/TerminalHeader';

vi.mock('@/features/terminal-component-group', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/terminal-component-group')>();
  return {
    ...actual,
    AttentionInbox: () => (
      <button type="button" data-testid="attention-inbox" aria-label="Attention inbox">
        Inbox
      </button>
    ),
  };
});

const dripStyles = {
  blur: 16,
  bgOpacity: 0.95,
  borderOpacity: 0.6,
  shadowIntensity: 0.2,
  glow: 0,
  glowOpacity: 0,
  saturation: 1,
  brightness: 1,
  backgroundColorsScalar: 0,
  borderColorScalar: 0,
  borderRgb: 'rgba(229, 231, 235, 0.6)',
};

function renderHeader(overrides: Partial<ComponentProps<typeof TerminalHeader>> = {}) {
  const props: ComponentProps<typeof TerminalHeader> = {
    onCreateNewAgent: vi.fn(),
    onSelectAgent: vi.fn(),
    onLoginClick: vi.fn(),
    isSignedIn: false,
    clientSource: 'WEB',
    realtimeReady: true,
    agents: [],
    isLoadingAgents: false,
    selectedAgentId: null,
    onResumeAgent: vi.fn().mockResolvedValue(undefined),
    resumingAgentId: null,
    dripStyles,
    blur: 0,
    backgroundColors: 0,
    borderColor: 0,
    shadowIntensity: 0,
    ...overrides,
  };

  renderWithProviders(<TerminalHeader {...props} />);
  return props;
}

describe('TerminalHeader responsive auth action', () => {
  it('keeps mobile header edge padding consistent between logo and login action', () => {
    renderHeader({ isSignedIn: false });

    expect(screen.getByRole('banner')).toHaveClass('p-2');
    expect(screen.getByRole('button', { name: /Rose/ })).not.toHaveClass('px-1');
    expect(screen.getByRole('button', { name: 'Login' })).toHaveClass('h-8');
  });

  it('shows a mobile login action instead of the inbox when signed out', () => {
    const props = renderHeader({ isSignedIn: false });

    const loginButton = screen.getByRole('button', { name: 'Login' });
    expect(loginButton).toHaveClass('md:hidden');
    fireEvent.click(loginButton);
    expect(props.onLoginClick).toHaveBeenCalledOnce();

    expect(screen.getByTestId('attention-inbox').parentElement).toHaveClass('hidden', 'md:block');
  });

  it('keeps the inbox as the header action when signed in', () => {
    renderHeader({ isSignedIn: true });

    expect(screen.queryByRole('button', { name: 'Login' })).not.toBeInTheDocument();
    expect(screen.getByTestId('attention-inbox').parentElement).not.toHaveClass('hidden');
  });

  it('shows a mobile-only agents drawer trigger when signed in', () => {
    renderHeader({ isSignedIn: true });

    const trigger = screen.getByRole('button', { name: 'Open agents menu' });
    expect(trigger).toBeInTheDocument();
    // Mobile-only: the desktop AppSidebar owns the agent list at >= md.
    expect(trigger).toHaveClass('md:hidden');
  });

  it('does not render the agents drawer trigger when signed out', () => {
    renderHeader({ isSignedIn: false });

    expect(screen.queryByRole('button', { name: 'Open agents menu' })).not.toBeInTheDocument();
  });
});
