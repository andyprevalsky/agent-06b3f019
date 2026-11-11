/**
 * Blackbox tests for the Rose left bar's row order (Andy, 2026-11-07: "these
 * finished agents sorted to the top"). Contract (agentListOrdering.sortAgents):
 * pinned first, then running, then needs-input, then finished, each tier by
 * newest user message. A pinned row is the only way a finished agent outranks
 * a running one, so an expanded pinned row shows a pin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { expandBar, mockProjectsApi, signedInUser } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const RUNNING = { status: 'ACTIVE' as const, temporal_workflow_id: 'wf-1' };
// Relative to now: finished rows older than OLD_AGENT_AGE_MS (4 days) move to the old-agents
// fold, so a fixed calendar anchor silently expired this contract on 2026-11-11T12:00Z.
const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function renderBar(overrides: Parameters<typeof defaultProps>[0]) {
  const user = signedInUser();
  return renderWithProviders(<AppSidebar {...defaultProps({ user, ...overrides })} />, {
    roseThemeUserId: user.id,
  });
}

function agentOrder(): string[] {
  const groups = screen.getByTestId('rose-agent-groups');
  return [...groups.querySelectorAll<HTMLElement>('[data-testid^="rose-agent-row-"]')].map((el) =>
    el.dataset.testid!.replace('rose-agent-row-', ''),
  );
}

describe('Rose left bar row order', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    mockProjectsApi([]);
  });
  afterEach(() => localStorage.clear());

  it('keeps running and needs-input agents above finished ones, whatever order the API returns', async () => {
    // Finished rows carry the freshest updated_at and are listed first.
    const row = (id: string, extra: Parameters<typeof makeAgent>[0]) =>
      makeAgent({ agent_id: id, goal: id, project_id: null, updated_at: at(0), ...extra });
    const agents = [
      row('sanna-failed', { status: 'FAILED', created_at: at(1) }),
      row('test-done', { status: 'COMPLETED', created_at: at(2) }),
      row('steam-done', { status: 'COMPLETED', created_at: at(3) }),
      row('sauna-run', { ...RUNNING, created_at: at(60) }),
      row('lemon-wait', { ...RUNNING, created_at: at(120) }),
      row('doordash-wait', { ...RUNNING, created_at: at(180) }),
    ];
    renderBar({ agents, attentionAgentIds: new Set(['lemon-wait', 'doordash-wait']) });
    expandBar();
    await screen.findByTestId('rose-home-project-row');
    expect(agentOrder()).toEqual([
      'sauna-run',
      'lemon-wait',
      'doordash-wait',
      'sanna-failed',
      'test-done',
      'steam-done',
    ]);
    expect(screen.queryByTestId('rose-agent-pinned')).toBeNull();
  });

  it('a pinned finished agent stays on top and shows a pin, so the order is visibly deliberate', async () => {
    const agents = [
      makeAgent({ agent_id: 'run', goal: 'run', ...RUNNING, created_at: at(1) }),
      makeAgent({
        agent_id: 'pinned-done',
        goal: 'pinned-done',
        status: 'COMPLETED',
        pinned_at: at(5),
        created_at: at(9),
      }),
    ];
    renderBar({ agents });
    expandBar();
    await screen.findByTestId('rose-home-project-row');
    expect(agentOrder()).toEqual(['pinned-done', 'run']);
    expect(
      within(screen.getByTestId('rose-agent-row-pinned-done')).getByTestId('rose-agent-pinned'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('rose-agent-row-run')).queryByTestId('rose-agent-pinned'),
    ).toBeNull();
  });
});
