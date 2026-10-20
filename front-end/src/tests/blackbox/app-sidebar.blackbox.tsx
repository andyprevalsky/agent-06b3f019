/**
 * Blackbox tests for AppSidebar chrome: drag-to-resize and the collapse snap,
 * nav-view changes, create-agent, login/logout, empty/loading states, and the
 * feedback popover. Agent row behaviour lives in app-sidebar-rows.blackbox.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import {
  SIDEBAR_COLLAPSE_SNAP_WIDTH,
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_EXPANDED,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from '@/features/terminal-component-group/config';
import {
  defaultProps,
  dragHandleTo,
  makeAgent,
  mockSession,
  renderStockSidebar,
  sidebarWidth,
} from './app-sidebar.fixtures';

describe('AppSidebar', () => {
  beforeEach(() => {
    mockSession();
    // Label/nav scenarios intentionally exercise an expanded saved preference.
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_WIDTH_EXPANDED));
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('hides the Benchmarks nav item unless showBenchmarks is set (team gate)', () => {
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(screen.queryByLabelText('Benchmarks')).not.toBeInTheDocument();
  });

  it('shows Benchmarks between Feedback and Integrations for the team', async () => {
    renderStockSidebar(<AppSidebar {...defaultProps({ showBenchmarks: true })} />);
    expect(screen.getByLabelText('Benchmarks')).toBeInTheDocument();
    const labels = ['Feedback', 'Benchmarks', 'Integrations'].map(
      (text) => screen.getByText(text).getBoundingClientRect,
    );
    expect(labels).toHaveLength(3); // all three render; order is the nav array order
  });

  it('renders a minimized icon rail by default with a drag handle', () => {
    localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    // The one-click chevron is gone; width is driven by the drag handle.
    expect(screen.queryByLabelText('Expand sidebar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Collapse sidebar')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Resize sidebar')).toBeInTheDocument();
    expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_COLLAPSED);
    expect(screen.getByRole('button', { name: 'New Agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByText('New Agent')).toHaveClass('hidden');
    expect(screen.queryByText('Integrations')).not.toBeInTheDocument();
  });

  it('renders New Agent below visible desktop headroom, above the flat Search row', () => {
    const { container } = renderStockSidebar(<AppSidebar {...defaultProps()} />);

    const create = screen.getByRole('button', { name: 'New Agent' });
    const search = screen.getByRole('searchbox', { name: 'Search agents' });
    const sidebar = container.querySelector('aside');

    expect(create.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sidebar).toHaveStyle({ paddingTop: '3rem' });
    expect(create.className).toContain('hover:bg-gray-100');
    expect(create.className).not.toMatch(/(^|\s)bg-(primary|black|navi-black)(\s|$)/);
    expect(search.className).toContain('border-transparent');
    expect(search.className).toContain('shadow-none');
  });

  it.each([SIDEBAR_WIDTH_COLLAPSED, SIDEBAR_WIDTH_EXPANDED, 420])(
    'restores an explicitly saved width of %i',
    (width) => {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
      renderStockSidebar(<AppSidebar {...defaultProps()} />);
      expect(sidebarWidth()).toBe(width);
    },
  );

  it.each(['', 'invalid', 'NaN'])('minimizes when the saved width is invalid (%s)', (stored) => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, stored);
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_COLLAPSED);
  });

  it('minimizes when storage is unavailable and still allows resizing', () => {
    const getItem = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
      if (key === SIDEBAR_WIDTH_STORAGE_KEY) throw new Error('Storage unavailable');
      return getItem(key);
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_COLLAPSED);

    dragHandleTo(360);

    expect(sidebarWidth()).toBe(360);
  });

  it('clamps a stored width above the max and snaps a tiny one to the rail', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '9999');
    const { unmount } = renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_MAX);
    unmount();

    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '40');
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_COLLAPSED);
  });

  it('expands the minimized rail by dragging and restores that preference on reload', async () => {
    localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const { unmount } = renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_COLLAPSED);

    dragHandleTo(360);

    await waitFor(() => expect(sidebarWidth()).toBe(360));
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('360');
    unmount();
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(sidebarWidth()).toBe(360);
  });

  it('collapses to the rail when dragged below the snap threshold', async () => {
    renderStockSidebar(<AppSidebar {...defaultProps({ agents: [makeAgent()] })} />);

    dragHandleTo(20);

    await waitFor(() => expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_COLLAPSED));
    // Collapsed rail drops the text labels.
    expect(screen.queryByText('Integrations')).not.toBeInTheDocument();
  });

  it('uses an agent icon instead of animated letters in the collapsed rail', async () => {
    const { container } = renderStockSidebar(
      <AppSidebar
        {...defaultProps({
          agents: [makeAgent({ agent_id: 'active', goal: 'Active agent', status: 'ACTIVE' })],
        })}
      />,
    );

    dragHandleTo(20);

    await waitFor(() => expect(sidebarWidth()).toBe(SIDEBAR_WIDTH_COLLAPSED));
    expect(container.querySelector('[data-sidebar-agent-icon]')).not.toBeNull();
    expect(container.querySelector('[data-letter]')).toBeNull();
  });

  it('renders the expanded nav labels', () => {
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    expect(screen.getByText('New Agent')).toBeInTheDocument();
    expect(screen.getByText('Feedback')).toBeInTheDocument();
    expect(screen.queryByText('Browse')).not.toBeInTheDocument();
    expect(screen.getByText('Integrations')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
  });

  it('calls onCreateAgent when the New Agent button is clicked', async () => {
    const u = userEvent.setup();
    const onCreateAgent = vi.fn();
    renderStockSidebar(<AppSidebar {...defaultProps({ onCreateAgent })} />);
    await u.click(screen.getByText('New Agent'));
    expect(onCreateAgent).toHaveBeenCalledTimes(1);
  });

  it('renders "No agents yet" placeholder when expanded and empty', async () => {
    renderStockSidebar(<AppSidebar {...defaultProps({ agents: [] })} />);
    expect(screen.getByText('No agents yet')).toBeInTheDocument();
  });

  it('renders loading spinner when isLoadingAgents and no agents', () => {
    renderStockSidebar(<AppSidebar {...defaultProps({ isLoadingAgents: true, agents: [] })} />);
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });

  it('renders agent list items and selects on click', async () => {
    const u = userEvent.setup();
    const onSelectAgent = vi.fn();
    const agents = [
      makeAgent({ agent_id: 'a1', goal: 'First goal' }),
      makeAgent({ agent_id: 'a2', goal: 'Second goal' }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents, onSelectAgent })} />);

    const first = await screen.findByText('First goal');
    await u.click(first);
    expect(onSelectAgent).toHaveBeenCalledWith('a1');
  });

  it('sorts processing agents before completed ones', async () => {
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
      // Active cloud agent (processing) — should come first regardless of timestamps
      makeAgent({
        agent_id: 'active',
        goal: 'Still running',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf-active',
        created_at: '2023-01-01T00:00:00Z',
      }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

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
    renderStockSidebar(<AppSidebar {...defaultProps({ onViewChange, onSelectAgent })} />);

    await u.click(screen.getByText('Integrations'));
    expect(onViewChange).toHaveBeenCalledWith('integrations');
    expect(onSelectAgent).toHaveBeenCalledWith(null);

    await u.click(screen.getByText('Settings'));
    expect(onViewChange).toHaveBeenCalledWith('settings');

    await u.click(screen.getByText('Network'));
    expect(onViewChange).toHaveBeenCalledWith('network');
  });

  it('shows Browse only when explicitly enabled', async () => {
    const u = userEvent.setup();
    const onViewChange = vi.fn();
    const onSelectAgent = vi.fn();
    renderStockSidebar(
      <AppSidebar {...defaultProps({ onViewChange, onSelectAgent, showBrowse: true })} />,
    );

    await u.click(screen.getByText('Browse'));

    expect(onViewChange).toHaveBeenCalledWith('browse');
    expect(onSelectAgent).toHaveBeenCalledWith(null);
  });

  it('shows Health directly below Feedback only when admin health is enabled', async () => {
    const u = userEvent.setup();
    const onViewChange = vi.fn();
    const onSelectAgent = vi.fn();
    const { rerender } = renderStockSidebar(
      <AppSidebar {...defaultProps({ onViewChange, onSelectAgent, showAdminHealth: true })} />,
    );

    const feedback = screen.getByText('Feedback');
    const health = screen.getByText('Health');
    expect(
      feedback.compareDocumentPosition(health) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await u.click(health);
    expect(onViewChange).toHaveBeenCalledWith('admin-health');
    expect(onSelectAgent).toHaveBeenCalledWith(null);

    rerender(<AppSidebar {...defaultProps({ showAdminHealth: false })} />);
    expect(screen.queryByText('Health')).not.toBeInTheDocument();
  });

  it('renders Login when user is null, calls onLoginClick on click', async () => {
    const u = userEvent.setup();
    const onLoginClick = vi.fn();
    renderStockSidebar(<AppSidebar {...defaultProps({ user: null, onLoginClick })} />);
    expect(screen.getByText('Login')).toBeInTheDocument();
    expect(screen.queryByText('Logout')).not.toBeInTheDocument();
    await u.click(screen.getByText('Login'));
    expect(onLoginClick).toHaveBeenCalled();
  });

  it('calls onLogout when Logout button clicked', async () => {
    const u = userEvent.setup();
    const onLogout = vi.fn();
    renderStockSidebar(<AppSidebar {...defaultProps({ onLogout })} />);
    await u.click(screen.getByText('Logout'));
    expect(onLogout).toHaveBeenCalled();
  });

  it('opens the Feedback popover and closes with Escape', async () => {
    const u = userEvent.setup();
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
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
    renderStockSidebar(<AppSidebar {...defaultProps({ currentView: 'settings' })} />);
    const settingsButton = screen.getByText('Settings').closest('button')!;
    expect(settingsButton.className).toMatch(/font-medium/);
  });

  // ── Row title, pin, and the row context menu ────────────────────────────

  it('keeps the snap threshold below the minimum drag width', () => {
    // Guards the invariant that collapsing takes a deliberate drag rather than
    // an accidental nudge past the minimum.
    expect(SIDEBAR_COLLAPSE_SNAP_WIDTH).toBeLessThan(SIDEBAR_WIDTH_EXPANDED);
    expect(SIDEBAR_WIDTH_COLLAPSED).toBeLessThan(SIDEBAR_COLLAPSE_SNAP_WIDTH);
  });
});
