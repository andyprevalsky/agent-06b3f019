/**
 * Rose Desktop expanded drawer (the query-box nub tab) after Andy's 2026-10-28
 * request: Report bug is its own drawer item outside Agent Settings, the
 * settings panel opened from the drawer has no Delete Agent, and hovering the
 * settings gear shows only the plain "Agent settings" label (click opens it).
 * Delete stays reachable via the stock gear and the sidebar Archive item.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import AgentSettingsDialog from '@/features/terminal-component-group/components/AgentSettingsDialog';
import ReportBugDialog from '@/features/terminal-component-group/components/ReportBugDialog';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import type { AgentDetail } from '@/lib/api';

const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

function mockSession(userId = 'test-user') {
  const phone = userId === ANDY_USER_ID ? '+19729777432' : undefined;
  const user = { id: userId, is_anonymous: false, phone };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
}

function makeAgent(): AgentDetail {
  return {
    agent_id: 'agent-xyz',
    goal: 'Test',
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.5,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: 'wf-1',
    token_count: 1000,
    tokens_in: 500,
    tokens_out: 300,
    tool_tokens_in: 100,
    tool_tokens_out: 50,
    tool_cost_cents: 10,
    context_size: 20_000,
    message_count: 7,
    price_limit_cents: 500,
    tree_cost_cents: 25,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    write_lock_enabled: false,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
    response_schema: null,
  } as AgentDetail;
}

const queryProps = {
  value: '',
  onChange: vi.fn(),
  onSubmit: vi.fn(),
  selectedModel: 'rose-labs/rose-1-flash',
  availableModels: [
    { id: 'rose-labs/rose-1-flash', name: 'rose-fast', provider: 'rose-labs', description: 'fast' },
  ],
};

describe('Report bug outside Agent Settings', () => {
  afterEach(() => localStorage.clear());

  it('Report bug lives outside Agent Settings: the settings panel has none, even for admins', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} variant="nub" />);
    await u.click(screen.getByLabelText('Agent settings'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Metrics')).toBeInTheDocument();
    expect(within(panel).queryByText(/Report Bug/i)).toBeNull();
    expect(within(panel).queryByTestId('report-bug-description')).toBeNull();
  });

  it('the Rose Desktop drawer settings panel shows no Delete Agent', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} variant="nub" />);
    await u.click(screen.getByLabelText('Agent settings'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Metrics')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Delete Agent/ })).toBeNull();
  });

  it('Cancel closes the Report bug panel and a reopen starts a fresh draft', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));
    await u.type(await screen.findByTestId('report-bug-description'), 'draft');
    await u.click(screen.getByTestId('report-bug-cancel'));
    await waitFor(() => expect(screen.queryByTestId('report-bug-dialog')).toBeNull());
    await u.click(screen.getByTestId('report-bug-trigger'));
    expect(await screen.findByTestId('report-bug-description')).toHaveValue('');
  });
});

describe('Rose Desktop expanded drawer (query-box nub tab): Report bug, settings, delete', () => {
  afterEach(() => localStorage.clear());

  function renderDrawer() {
    renderWithProviders(<QueryInput {...queryProps} agentDetail={makeAgent()} />, {
      roseDesktop: true,
    });
    const nub = screen.getByTestId('query-toolbar-nub');
    // Expand the drawer (tap pins it open, as a user does).
    fireEvent.pointerDown(nub, { pointerType: 'touch' });
    fireEvent.click(nub);
    expect(nub).toHaveAttribute('data-state', 'open');
    return nub;
  }

  it('admins reach Report bug from its own drawer item, right after the settings gear', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    const nub = renderDrawer();
    const labels = within(nub)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels.indexOf('Report bug')).toBe(labels.indexOf('Agent settings') + 1);
    const bug = within(nub).getByTestId('report-bug-trigger');
    await u.hover(bug);
    await waitFor(() =>
      expect(screen.getAllByTestId('nub-tip').map((t) => t.textContent)).toContain('Report bug'),
    );
    await u.click(bug);
    const panel = await screen.findByTestId('report-bug-dialog');
    expect(within(panel).getByTestId('report-bug-description')).toBeInTheDocument();
  });

  it('settings gear hover shows only the "Agent settings" label; the panel opens on click and has no Delete Agent', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    const nub = renderDrawer();
    const gear = within(nub).getByLabelText('Agent settings');
    await u.hover(gear);
    await waitFor(() =>
      expect(screen.getAllByTestId('nub-tip').map((t) => t.textContent)).toContain(
        'Agent settings',
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Metrics')).toBeNull();
    await u.click(gear);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Metrics')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Delete Agent/ })).toBeNull();
    expect(within(panel).queryByText(/Report Bug/i)).toBeNull();
  });

  it('non-admin drawer has no Report bug item', () => {
    mockSession();
    const nub = renderDrawer();
    expect(within(nub).queryByTestId('report-bug-trigger')).toBeNull();
  });
});
