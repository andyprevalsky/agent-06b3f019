/**
 * Blackbox tests for TerminalHeader responsive auth actions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    onLogout: vi.fn(),
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
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  });

  it('keeps mobile header edge padding consistent between logo and login action', () => {
    renderHeader({ isSignedIn: false });

    expect(screen.getByRole('banner')).toHaveClass('px-4');
    expect(screen.getByRole('button', { name: /Rose/ })).not.toHaveClass('px-1');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveClass('h-9');
  });

  it('shows login inside the mobile menu instead of mounting the desktop inbox', async () => {
    const user = userEvent.setup();
    const props = renderHeader({ isSignedIn: false });

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const loginButton = screen.getByRole('button', { name: 'Login' });
    await user.click(loginButton);
    expect(props.onLoginClick).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('attention-inbox')).not.toBeInTheDocument();
  });

  it('keeps the inbox as the desktop header action when signed in', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    renderHeader({ isSignedIn: true });

    expect(screen.getByTestId('attention-inbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
  });

  it('shows a mobile-only agents drawer trigger when signed in', () => {
    renderHeader({ isSignedIn: true });

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    expect(trigger).toBeInTheDocument();
    // Mobile-only: the desktop AppSidebar owns the agent list at >= md.
    expect(trigger).toHaveClass('md:hidden');
  });

  it('renders the mobile menu trigger when signed out', () => {
    renderHeader({ isSignedIn: false });

    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
  });
});
