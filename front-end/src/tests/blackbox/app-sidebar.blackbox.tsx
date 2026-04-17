/**
 * Blackbox tests for AppSidebar.
 * Covers agent list rendering + sorting, collapse/expand toggle, create-agent callback,
 * nav-view changes, login/logout rendering, empty/loading states, and the
 * feedback popover.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import type { Agent } from '@/lib/api';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

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

function defaultProps(overrides: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  return {
    currentView: 'agents' as const,
    onViewChange: vi.fn(),
    agents: [] as Agent[],
    isLoadingAgents: false,
    selectedAgentId: null,
    onSelectAgent: vi.fn(),
    onCreateAgent: vi.fn(),
    onResumeAgent: vi.fn().mockResolvedValue(undefined),
    resumingAgentId: null,
    user: { id: 'test-user' },
    onLogout: vi.fn(),
    onLoginClick: vi.fn(),
    ...overrides,
  };
}

describe('AppSidebar', () => {
  beforeEach(() => {
    mockSession();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders in collapsed state by default with Expand button', () => {
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument();
  });

  it('toggles to expanded state on toggle-button click', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    await u.click(screen.getByLabelText('Expand sidebar'));
    // Now the label flips to "Collapse sidebar"
    expect(screen.getByLabelText('Collapse sidebar')).toBeInTheDocument();
    // And visible labels appear: Create Agent, Feedback, Integrations, Settings, Logout
    expect(screen.getByText('Create Agent')).toBeInTheDocument();
    expect(screen.getByText('Feedback')).toBeInTheDocument();
    expect(screen.getByText('Integrations')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
  });

  it('calls onCreateAgent when Create Agent button is clicked', async () => {
    const u = userEvent.setup();
    const onCreateAgent = vi.fn();
    renderWithProviders(<AppSidebar {...defaultProps({ onCreateAgent })} />);
    // Expand first to see the text
    await u.click(screen.getByLabelText('Expand sidebar'));
    await u.click(screen.getByText('Create Agent'));
    expect(onCreateAgent).toHaveBeenCalledTimes(1);
  });

  it('renders "No agents yet" placeholder when expanded and empty', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AppSidebar {...defaultProps({ agents: [] })} />);
    await u.click(screen.getByLabelText('Expand sidebar'));
    expect(screen.getByText('No agents yet')).toBeInTheDocument();
  });

  it('renders loading spinner when isLoadingAgents and no agents', () => {
    renderWithProviders(<AppSidebar {...defaultProps({ isLoadingAgents: true, agents: [] })} />);
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });

  it('renders agent list items and selects on click', async () => {
    const u = userEvent.setup();
    const onSelectAgent = vi.fn();
    const agents = [
      makeAgent({ agent_id: 'a1', goal: 'First goal' }),
      makeAgent({ agent_id: 'a2', goal: 'Second goal' }),
    ];
    renderWithProviders(<AppSidebar {...defaultProps({ agents, onSelectAgent })} />);
    await u.click(screen.getByLabelText('Expand sidebar'));

    const first = await screen.findByText('First goal');
    await u.click(first);
    expect(onSelectAgent).toHaveBeenCalledWith('a1');
  });

  it('sorts processing agents before completed ones', async () => {
    const u = userEvent.setup();
    const agents = [
      // Older completed agent
      makeAgent({
        agent_id: 'old-completed',
        goal: 'Completed task',
        status: 'COMPLETED',
        created_at: '2024-01-01T00:00:00Z',
      }),
      // Newer completed
      makeAgent({
        agent_id: 'new-completed',
        goal: 'Newer completed',
        status: 'COMPLETED',
        created_at: '2026-01-01T00:00:00Z',
      }),
      // Active (processing) — should come first regardless of timestamps
      makeAgent({
        agent_id: 'active',
        goal: 'Still running',
        status: 'ACTIVE',
        created_at: '2023-01-01T00:00:00Z',
      }),
    ];
    renderWithProviders(<AppSidebar {...defaultProps({ agents })} />);
    await u.click(screen.getByLabelText('Expand sidebar'));

    const nodes = await screen.findAllByRole('heading', { level: 3 });
    const texts = nodes.map((n) => n.textContent);
    expect(texts[0]).toBe('Still running'); // processing first
    // Then "Newer completed" (more recent) before "Completed task"
    expect(texts.indexOf('Newer completed')).toBeLessThan(texts.indexOf('Completed task'));
  });

  it('calls onViewChange and clears selection for nav items', async () => {
    const u = userEvent.setup();
    const onViewChange = vi.fn();
    const onSelectAgent = vi.fn();
    renderWithProviders(
      <AppSidebar {...defaultProps({ onViewChange, onSelectAgent })} />,
    );
    await u.click(screen.getByLabelText('Expand sidebar'));

    await u.click(screen.getByText('Integrations'));
    expect(onViewChange).toHaveBeenCalledWith('integrations');
    expect(onSelectAgent).toHaveBeenCalledWith(null);

    await u.click(screen.getByText('Settings'));
    expect(onViewChange).toHaveBeenCalledWith('settings');

    await u.click(screen.getByText('Network'));
    expect(onViewChange).toHaveBeenCalledWith('network');
  });

  it('renders Login when user is null, calls onLoginClick on click', async () => {
    const u = userEvent.setup();
    const onLoginClick = vi.fn();
    renderWithProviders(<AppSidebar {...defaultProps({ user: null, onLoginClick })} />);
    await u.click(screen.getByLabelText('Expand sidebar'));
    expect(screen.getByText('Login')).toBeInTheDocument();
    expect(screen.queryByText('Logout')).not.toBeInTheDocument();
    await u.click(screen.getByText('Login'));
    expect(onLoginClick).toHaveBeenCalled();
  });

  it('calls onLogout when Logout button clicked', async () => {
    const u = userEvent.setup();
    const onLogout = vi.fn();
    renderWithProviders(<AppSidebar {...defaultProps({ onLogout })} />);
    await u.click(screen.getByLabelText('Expand sidebar'));
    await u.click(screen.getByText('Logout'));
    expect(onLogout).toHaveBeenCalled();
  });

  it('opens the Feedback popover and closes with Escape', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    await u.click(screen.getByLabelText('Expand sidebar'));
    await u.click(screen.getByText('Feedback'));

    const input = await screen.findByPlaceholderText('Share your thoughts...');
    expect(input).toBeInTheDocument();

    await u.type(input, 'Nice app');
    expect((input as HTMLInputElement).value).toBe('Nice app');

    await u.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Share your thoughts...')).not.toBeInTheDocument();
    });
  });

  it('marks current view as active', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AppSidebar {...defaultProps({ currentView: 'settings' })} />);
    await u.click(screen.getByLabelText('Expand sidebar'));
    const settingsButton = screen.getByText('Settings').closest('button')!;
    expect(settingsButton.className).toMatch(/font-medium/);
  });
});
