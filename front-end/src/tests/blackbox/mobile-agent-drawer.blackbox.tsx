/**
 * Blackbox tests for MobileAgentDrawer — the mobile-only slide-over that makes
 * the mobile menu reachable below the md breakpoint (the desktop AppSidebar is
 * `hidden md:flex`). Verifies the trigger is mobile-scoped, opening surfaces
 * the shared SidebarAgentList, and selecting/creating closes the drawer.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from './test-wrapper';
import { server } from './msw/server';
import { mockTeams } from './teams.fixtures';
import MobileAgentDrawer from '@/features/terminal-component-group/components/MobileAgentDrawer';
import type { Agent } from '@/lib/api';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    goal: 'A test goal',
    model: 'rose-1-flash',
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
    hasLoadedAgents: true,
    selectedAgentId: null,
    onSelectAgent: vi.fn(),
    onCreateAgent: vi.fn(),
    onRefreshAgents: vi.fn().mockResolvedValue(undefined),
    realtimeReady: false,
    isSignedIn: true,
    onLoginClick: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
}

/** Row mutations go through getAuthHeaders(), which throws without a session. */
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

describe('MobileAgentDrawer', () => {
  beforeEach(() => {
    mockSession();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

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
    const createButton = await screen.findByRole('button', { name: /New Agent/ });
    await u.click(createButton);

    expect(onCreateAgent).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /New Agent/ })).not.toBeInTheDocument();
    });
  });

  it('shows the same New Agent and Search chrome above the mobile list', async () => {
    const u = userEvent.setup();
    const agents = [
      makeAgent({ agent_id: 'a1', goal: 'Book Tokyo flight' }),
      makeAgent({ agent_id: 'a2', goal: 'Order groceries' }),
    ];
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ agents })} />);

    await u.click(screen.getByRole('button', { name: 'Open menu' }));

    const create = await screen.findByRole('button', { name: 'New Agent' });
    const search = screen.getByRole('searchbox', { name: 'Search agents' });
    expect(create.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await u.type(search, 'grocer');
    await waitFor(() => expect(screen.queryByText('Book Tokyo flight')).not.toBeInTheDocument());
    expect(screen.getByText('Order groceries')).toBeInTheDocument();
  });

  it('shows an empty-state placeholder when there are no agents', async () => {
    const u = userEvent.setup();
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ agents: [] })} />);
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
  });

  it('Rose list shows the spinner for the first load only, never for later polls', async () => {
    const u = userEvent.setup();
    server.use(http.get('*/api/projects', () => HttpResponse.json({ projects: [] })));
    const view = renderWithProviders(
      <MobileAgentDrawer
        {...defaultProps({ roseHeader: true, isLoadingAgents: true, hasLoadedAgents: false })}
      />,
    );
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await screen.findByLabelText('Loading agents')).toBeInTheDocument();
    view.rerender(<MobileAgentDrawer {...defaultProps({ roseHeader: true })} />);
    await u.click(await screen.findByRole('button', { name: '+ New project' }));
    await u.type(screen.getByRole('textbox', { name: 'New project name' }), 'Website');
    // A background poll on an account with no agents: in flight again, first load settled.
    view.rerender(
      <MobileAgentDrawer {...defaultProps({ roseHeader: true, isLoadingAgents: true })} />,
    );
    expect(screen.queryByLabelText('Loading agents')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'New project name' })).toHaveValue('Website');
  });

  it('keeps the tab switcher below the iOS safe-area inset', async () => {
    const u = userEvent.setup();
    renderWithProviders(<MobileAgentDrawer {...defaultProps()} />);

    await u.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(await screen.findByRole('dialog')).toHaveClass('pt-[var(--safe-area-inset-top)]');
    expect(screen.getByRole('button', { name: 'Agents' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeVisible();
  });

  it('shows the generated title rather than the raw goal', async () => {
    const u = userEvent.setup();
    const agents = [
      makeAgent({ goal: 'a very long raw goal that would wrap', title: 'Short Label' }),
    ];
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ agents })} />);
    await u.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(await screen.findByText('Short Label')).toBeInTheDocument();
    expect(screen.queryByText('a very long raw goal that would wrap')).not.toBeInTheDocument();
  });

  it('archives from the drawer and refreshes the list', async () => {
    const u = userEvent.setup();
    let deletedId: string | null = null;
    server.use(
      http.delete('*/api/agents/:agentId', ({ params }) => {
        deletedId = params.agentId as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    // Regression guard: the drawer builds its own useAgentRowActions, so a
    // caller that forgets onRefreshAgents would throw here rather than at
    // render time.
    const onRefreshAgents = vi.fn().mockResolvedValue(undefined);
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Row A' })];
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ agents, onRefreshAgents })} />);
    await u.click(screen.getByRole('button', { name: 'Open menu' }));

    await u.click(await screen.findByLabelText('Archive Row A'));

    await waitFor(() => expect(deletedId).toBe('a1'));
    await waitFor(() => expect(onRefreshAgents).toHaveBeenCalled());
  });
  it('closes the menu before opening Teams so the new panel owns focus', async () => {
    mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ roseHeader: true })} />);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.queryByRole('button', { name: 'Biz health' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Teams' }));
    expect(await screen.findByLabelText('Team title')).toBeInTheDocument();
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'open');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('places Teams beside the admin-only Biz health mobile entry', async () => {
    const session = JSON.parse(localStorage.getItem('rose-session')!);
    session.user.id = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
    localStorage.setItem('rose-session', JSON.stringify(session));
    const user = userEvent.setup();
    renderWithProviders(<MobileAgentDrawer {...defaultProps({ roseHeader: true })} />);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons.indexOf('Teams')).toBe(buttons.indexOf('Biz health') + 1);
  });
});
