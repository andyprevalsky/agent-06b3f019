/**
 * Blackbox tests for the Rose left bar's old-agent row (Andy, 2026-10-26:
 * "hide completed or failed agents, older than 4 days, in a small older
 * section … View X old agents"). Time is pinned; only Date is faked.
 *
 * Rule (oldAgents.ts): finished (Completed/Failed) and last active (updated_at)
 * more than 4 days ago; never running, paused/waiting, pinned or selected.
 * Same rule in the expanded bar, the collapsed rail and the mobile list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { RoseMobileAgentList } from '@/features/terminal-component-group/components/rose-sidebar/RoseMobileAgentList';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import {
  expandBar,
  makeProject,
  mockProjectsApi,
  roseBar,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const RUNNING = { status: 'ACTIVE' as const, temporal_workflow_id: 'wf-1' };

function renderBar(overrides: Parameters<typeof defaultProps>[0] = {}) {
  const user = signedInUser();
  return renderWithProviders(<AppSidebar {...defaultProps({ user, ...overrides })} />, {
    roseThemeUserId: user.id,
  });
}

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const lastActive = (msAgo: number) => ({
  created_at: new Date(NOW - 30 * DAY).toISOString(),
  updated_at: new Date(NOW - msAgo).toISOString(),
});
const OLD_AGENTS = [
  makeAgent({
    agent_id: 'h-boundary',
    goal: 'Exactly four days',
    status: 'COMPLETED',
    ...lastActive(4 * DAY),
  }),
  makeAgent({
    agent_id: 'h-old-done',
    goal: 'Old done',
    status: 'COMPLETED',
    ...lastActive(4 * DAY + 60_000),
  }),
  makeAgent({
    agent_id: 'h-old-fail',
    goal: 'Old failure',
    status: 'FAILED',
    ...lastActive(10 * DAY),
  }),
  makeAgent({ agent_id: 'h-running', goal: 'Still running', ...RUNNING, ...lastActive(10 * DAY) }),
  makeAgent({
    agent_id: 'h-paused',
    goal: 'Paused one',
    status: 'PAUSED',
    ...lastActive(10 * DAY),
  }),
  makeAgent({
    agent_id: 'h-waiting',
    goal: 'Out of credits',
    status: 'OUT_OF_CREDITS',
    ...lastActive(10 * DAY),
  }),
  makeAgent({
    agent_id: 'h-pinned',
    goal: 'Pinned old',
    status: 'COMPLETED',
    pinned_at: new Date(NOW - 20 * DAY).toISOString(),
    ...lastActive(10 * DAY),
  }),
  makeAgent({
    agent_id: 'h-created-old',
    goal: 'Created long ago, active today',
    status: 'COMPLETED',
    ...lastActive(60 * 60_000),
  }),
  makeAgent({
    agent_id: 'r-old',
    goal: 'Old project work',
    status: 'COMPLETED',
    project_id: 'p-rose',
    ...lastActive(6 * DAY),
  }),
  makeAgent({
    agent_id: 'r-recent',
    goal: 'Recent project work',
    status: 'COMPLETED',
    project_id: 'p-rose',
    ...lastActive(60_000),
  }),
];
const VISIBLE_HOME = [
  'h-boundary',
  'h-running',
  'h-paused',
  'h-waiting',
  'h-pinned',
  'h-created-old',
];

function rowIn(group: string, id: string) {
  return within(screen.getByTestId(`rose-group-${group}`)).queryByTestId(`rose-agent-row-${id}`);
}

describe('Rose left bar: old agents', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    localStorage.clear();
    mockSession();
    clearCaptures();
    mockProjectsApi([makeProject()]);
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('hides finished agents last active more than 4 days ago behind "View X old agents" per group', async () => {
    renderBar({ agents: OLD_AGENTS });
    expandBar();
    await screen.findByTestId('rose-project-row-p-rose');
    // Exactly 4 days, running, paused, waiting, pinned and recently active (old createdAt) stay.
    for (const id of VISIBLE_HOME) expect(rowIn('home', id)).not.toBeNull();
    expect(rowIn('home', 'h-old-done')).toBeNull();
    expect(rowIn('home', 'h-old-fail')).toBeNull();
    expect(rowIn('p-rose', 'r-old')).toBeNull();
    expect(rowIn('p-rose', 'r-recent')).not.toBeNull();
    const home = within(screen.getByTestId('rose-group-home'));
    expect(home.getByRole('button', { name: 'View 2 old agents' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const project = within(screen.getByTestId('rose-group-p-rose'));
    expect(project.getByRole('button', { name: 'View 1 old agent' })).toBeInTheDocument();
    // The quiet row is the last row of its group; no wrapper around it.
    const homeGroup = screen.getByTestId('rose-group-home');
    expect(homeGroup.lastElementChild).toHaveTextContent('View 2 old agents');
    expect(homeGroup.lastElementChild?.tagName).toBe('BUTTON');
  });

  it('expands in place and collapses again, with no request', async () => {
    renderBar({ agents: OLD_AGENTS });
    expandBar();
    await screen.findByTestId('rose-project-row-p-rose');
    await waitFor(() => expect(capturedRequests.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = capturedRequests.length;
    const home = within(screen.getByTestId('rose-group-home'));
    fireEvent.click(home.getByRole('button', { name: 'View 2 old agents' }));
    expect(rowIn('home', 'h-old-done')).not.toBeNull();
    expect(rowIn('home', 'h-old-fail')).not.toBeNull();
    const toggle = home.getByRole('button', { name: 'Hide 2 old agents' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // In place: after the recent rows, above the row that collapses them.
    const rows = [
      ...screen.getByTestId('rose-group-home').querySelectorAll('[data-testid^="rose-agent-row-"]'),
    ];
    expect(rows.slice(-2).map((r) => r.getAttribute('data-testid'))).toEqual([
      'rose-agent-row-h-old-done',
      'rose-agent-row-h-old-fail',
    ]);
    // Other groups keep their own state.
    expect(rowIn('p-rose', 'r-old')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      capturedRequests.slice(before).map((r) => `${r.method} ${new URL(r.url).pathname}`),
    ).toEqual([]);
    fireEvent.click(toggle);
    expect(rowIn('home', 'h-old-done')).toBeNull();
    expect(home.getByRole('button', { name: 'View 2 old agents' })).toBeInTheDocument();
  });

  it('the selected agent is never hidden or counted, even when old', async () => {
    renderBar({ agents: OLD_AGENTS, selectedAgentId: 'h-old-done' });
    expandBar();
    await screen.findByTestId('rose-project-row-p-rose');
    expect(rowIn('home', 'h-old-done')).not.toBeNull();
    expect(rowIn('home', 'h-old-fail')).toBeNull();
    expect(
      within(screen.getByTestId('rose-group-home')).getByRole('button', {
        name: 'View 1 old agent',
      }),
    ).toBeInTheDocument();
  });

  it('the collapsed rail hides old agents by the same rule (no row text there)', async () => {
    renderBar({ agents: OLD_AGENTS });
    await screen.findByTestId('rose-agent-row-h-running');
    expect(roseBar()).toHaveAttribute('data-expanded', 'false');
    expect(screen.queryByTestId('rose-agent-row-h-old-done')).toBeNull();
    expect(screen.queryByTestId('rose-agent-row-r-old')).toBeNull();
    expect(screen.getByTestId('rose-agent-row-h-boundary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /old agents?$/ })).toBeNull();
  });

  it('the mobile list hides old agents by the same rule', async () => {
    renderWithProviders(
      <RoseMobileAgentList
        agents={OLD_AGENTS}
        selectedAgentId={null}
        onSelectAgent={vi.fn()}
        onClose={vi.fn()}
        handlers={{
          onRenameAgent: vi.fn(),
          onCopyAgentLink: vi.fn(),
          onToggleAgentPin: vi.fn(),
          onArchiveAgent: vi.fn(),
        }}
        query=""
        contentMatchAgentIds={new Set()}
        isLoading={false}
        isSearching={false}
        searchError={null}
      />,
    );
    await screen.findByTestId('rose-project-row-p-rose');
    expect(rowIn('home', 'h-old-done')).toBeNull();
    expect(rowIn('home', 'h-running')).not.toBeNull();
    const home = within(screen.getByTestId('rose-group-home'));
    fireEvent.click(home.getByRole('button', { name: 'View 2 old agents' }));
    expect(rowIn('home', 'h-old-done')).not.toBeNull();
  });
});
