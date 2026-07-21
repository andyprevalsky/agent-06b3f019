/**
 * Blackbox tests for MobileAgentDrawer — the mobile-only slide-over that makes
 * the mobile menu reachable below the md breakpoint (the desktop AppSidebar is
 * `hidden md:flex`). Verifies the trigger is mobile-scoped, opening surfaces
 * the shared SidebarAgentList, and selecting/creating closes the drawer.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import MobileAgentDrawer from '@/features/terminal-component-group/components/MobileAgentDrawer';
import type { Agent } from '@/lib/api';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    goal: 'A test goal',
    model: 'rose-1-lite',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.25,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: null,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 0,
    price_limit_cents: 100,
    tree_cost_cents: 0,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    write_lock_enabled: false,
    ...overrides,
  };
}

function defaultProps(overrides: Partial<React.ComponentProps<typeof MobileAgentDrawer>> = {}) {
  return {
    agents: [] as Agent[],
    isLoadingAgents: false,
    selectedAgentId: null,
    onSelectAgent: vi.fn(),
    onCreateAgent: vi.fn(),
    onResumeAgent: vi.fn().mockResolvedValue(undefined),
    resumingAgentId: null,
    realtimeReady: false,
    isSignedIn: true,
    onLoginClick: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
}

describe('MobileAgentDrawer', () => {
  it('renders a mobile-only trigger (hidden at >= md)', () => {
    renderWithProviders(<MobileAgentDrawer {...defaultProps()} />);
    const trigger = screen.getByRole('button', { name: 'Open menu' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass('md:hidden');
  });

  it('opens the drawer and lists agents, selecting one calls onSelectAgent and closes', async () => {
    const u = userEvent.setup();
    const onSelectAgent = vi.fn();
    const agents = [
      makeAgent({ agent_id: 'a1', goal: 'First goal' }),
      makeAgent({ agent_id: 'a2', goal: 'Second goal' }),
    ];
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ agents, onSelectAgent })} />);

    // List is not visible until the drawer is opened.
    expect(screen.queryByText('First goal')).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Open menu' }));

    const first = await screen.findByText('First goal');
    expect(screen.getByText('Second goal')).toBeInTheDocument();

    await u.click(first);
    expect(onSelectAgent).toHaveBeenCalledWith('a1');

    // Selecting closes the drawer.
    await waitFor(() => {
      expect(screen.queryByText('First goal')).not.toBeInTheDocument();
    });
  });

  it('exposes a Create Agent affordance that calls onCreateAgent and closes', async () => {
    const u = userEvent.setup();
    const onCreateAgent = vi.fn();
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ onCreateAgent })} />);

    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    const createButton = await screen.findByRole('button', { name: /Create Agent/ });
    await u.click(createButton);

    expect(onCreateAgent).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Create Agent/ })).not.toBeInTheDocument();
    });
  });

  it('shows an empty-state placeholder when there are no agents', async () => {
    const u = userEvent.setup();
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ agents: [] })} />);
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
  });
});
