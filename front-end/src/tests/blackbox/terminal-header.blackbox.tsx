/**
 * Blackbox tests for TerminalHeader responsive auth actions on the stock UI
 * (Rose Desktop flag off). The flagged mobile header (hamburger · Rose pill ·
 * app icons) is covered by rose-mobile-header.blackbox.tsx.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { renderWithProviders } from './test-wrapper';

import { PhoneAuthModal } from '@/features/auth';
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
    onRefreshAgents: vi.fn(),
    onSelectAgent: vi.fn(),
    onLoginClick: vi.fn(),
    onLogout: vi.fn(),
    isSignedIn: false,
    clientSource: 'WEB',
    agents: [],
    isLoadingAgents: false,
    selectedAgentId: null,
    dripStyles,
    blur: 0,
    backgroundColors: 0,
    borderColor: 0,
    shadowIntensity: 0,
    ...overrides,
  };

  renderWithProviders(<TerminalHeader {...props} />, { roseDesktop: false });
  return props;
}

describe('TerminalHeader responsive auth action', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  });

  it('keeps mobile header edge padding consistent between logo and login action', () => {
    renderHeader({ isSignedIn: false });

    expect(screen.getByRole('banner')).toHaveClass(
      'px-4',
      'h-[var(--mobile-terminal-header-height)]',
    );
    expect(screen.getByRole('button', { name: /Rose/ })).not.toHaveClass('px-1');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveClass('h-9');
  });

  it('opens login from its existing location inside the mobile drawer', async () => {
    const user = userEvent.setup();
    const props = renderHeader({ isSignedIn: false });

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const loginButton = screen.getByRole('button', { name: 'Login' });
    await user.click(loginButton);
    await vi.waitFor(() => expect(props.onLoginClick).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.queryByTestId('attention-inbox')).not.toBeInTheDocument();
  });

  it('keeps the stateful phone auth modal open after the mobile login interaction settles', async () => {
    function MobileAuthHarness() {
      const [loginOpen, setLoginOpen] = useState(false);
      const props: ComponentProps<typeof TerminalHeader> = {
        ...renderHeaderProps,
        onLoginClick: () => setLoginOpen(true),
      };
      return (
        <>
          <TerminalHeader {...props} />
          <PhoneAuthModal open={loginOpen} onOpenChange={setLoginOpen} />
        </>
      );
    }

    const renderHeaderProps: ComponentProps<typeof TerminalHeader> = {
      onCreateNewAgent: vi.fn(),
      onRefreshAgents: vi.fn(),
      onSelectAgent: vi.fn(),
      onLoginClick: vi.fn(),
      onLogout: vi.fn(),
      isSignedIn: false,
      clientSource: 'WEB',
      agents: [],
      isLoadingAgents: false,
      selectedAgentId: null,
      dripStyles,
      blur: 0,
      backgroundColors: 0,
      borderColor: 0,
      shadowIntensity: 0,
    };

    const user = userEvent.setup();
    renderWithProviders(<MobileAuthHarness />, { roseDesktop: false });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(screen.getByRole('button', { name: 'Login' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByLabelText('Phone Number')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Login' })).not.toBeInTheDocument();
  });
});
