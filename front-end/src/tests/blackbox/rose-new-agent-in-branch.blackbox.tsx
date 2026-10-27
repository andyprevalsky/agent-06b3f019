/**
 * Blackbox: Rose Desktop agent right-click "New agent in this branch" through
 * the real Terminal (flag on), on the W5b contract (feat/rose-user-ui @
 * f78bf8aa8, back-end/src/domains/agents/agentCodeSessionShare.ts):
 *
 *   POST /api/agents { goal, …, share_code_session_with: <agentId> }
 *     → the new agent works in that agent's code session (same branch)
 *     → 404 { code: 'CODE_SESSION_SHARE_TARGET_NOT_FOUND' } when the target is gone
 *
 * The next goal after the menu item carries share_code_session_with (and the
 * target's project); New Super Agent clears it. A 404 shows a toast, restores
 * the goal and drops the share so the next send starts an ordinary agent.
 * Flag off: the stock sidebar offers no such item, so nothing sets the share.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { Toaster } from '@/components/ui/toaster';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import {
  SIDEBAR_WIDTH_EXPANDED,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from '@/features/terminal-component-group/config';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { defaultProps, makeAgent, openRowMenu, renderStockSidebar } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import { expandBar, makeProject, mockProjectsApi, openContextMenu } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';

function signInAs(userId: string) {
  const user = { id: userId, is_anonymous: false };
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

function agentCreates() {
  return capturedRequests.filter(
    (r) => r.method === 'POST' && new URL(r.url).pathname === '/api/agents',
  );
}

/** POST /api/agents echoing the client-minted id (the client rejects a mismatch). */
function serveCreates(reply?: (body: Record<string, unknown>) => Response | undefined) {
  server.use(
    http.post(`${API_BASE}/agents`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const custom = reply?.(body);
      if (custom) return custom;
      const now = new Date().toISOString();
      return HttpResponse.json({
        agent_id: body.agent_id,
        goal: body.goal,
        model: 'rose-1-flash',
        source: 'WEB',
        reasoning_effort: 'medium',
        progress: 0,
        status: 'STARTING_UP',
        status_message: null,
        temporal_workflow_id: 'wf-new',
        token_count: 0,
        tokens_in: 0,
        tokens_out: 0,
        context_size: 0,
        message_count: 0,
        price_limit_cents: 100,
        tree_cost_cents: 0,
        created_at: now,
        updated_at: now,
      });
    }),
  );
}

async function chooseNewAgentInBranch(agentId = 'agent-001') {
  await screen.findByTestId('rose-sidebar');
  expandBar();
  const menu = await openContextMenu(
    await screen.findByTestId(`rose-agent-row-${agentId}`),
    'rose-agent-menu',
  );
  fireEvent.click(within(menu).getByRole('menuitem', { name: /^New agent in this branch/ }));
}

async function sendGoal(user: ReturnType<typeof userEvent.setup>, goal: string) {
  const composer = await screen.findByPlaceholderText('Enter any goal');
  await user.click(composer);
  await user.type(composer, `${goal}{Enter}`);
}

beforeEach(() => {
  localStorage.clear();
  clearCaptures();
  signInAs(ROSE_DESKTOP_USER_IDS[0]);
  mockProjectsApi([makeProject()]);
  server.use(
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Test User' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
});
afterEach(() => localStorage.clear());

describe('New agent in this branch (Terminal, flag on)', () => {
  it('the next goal posts share_code_session_with = the row; New Super Agent clears it', async () => {
    const user = userEvent.setup({ delay: null });
    serveCreates();
    renderWithProviders(<Terminal />);
    await chooseNewAgentInBranch();
    await sendGoal(user, 'Add the retry button');
    await waitFor(() => expect(agentCreates()).toHaveLength(1));
    expect(agentCreates()[0].body).toEqual(
      expect.objectContaining({
        goal: 'Add the retry button',
        share_code_session_with: 'agent-001',
      }),
    );

    expandBar();
    fireEvent.click(screen.getByRole('button', { name: 'New Super Agent' }));
    await sendGoal(user, 'Plan Tahoe trip');
    await waitFor(() => expect(agentCreates()).toHaveLength(2));
    expect(agentCreates()[1].body).not.toHaveProperty('share_code_session_with');
  });

  it('404 CODE_SESSION_SHARE_TARGET_NOT_FOUND: toast, goal restored, the retry starts an ordinary agent', async () => {
    const user = userEvent.setup({ delay: null });
    serveCreates((body) =>
      body.share_code_session_with
        ? HttpResponse.json(
            {
              error: `Agent ${String(body.share_code_session_with)} not found`,
              code: 'CODE_SESSION_SHARE_TARGET_NOT_FOUND',
            },
            { status: 404 },
          )
        : undefined,
    );
    renderWithProviders(
      <>
        <Terminal />
        <Toaster />
      </>,
    );
    await chooseNewAgentInBranch();
    await sendGoal(user, 'Add the retry button');
    expect(await screen.findByText('Branch not found')).toBeInTheDocument();
    expect(screen.queryByText('Failed to create agent')).not.toBeInTheDocument();
    expect(agentCreates()[0].body).toEqual(
      expect.objectContaining({ share_code_session_with: 'agent-001' }),
    );
    const composer = await screen.findByPlaceholderText('Enter any goal');
    await waitFor(() => expect(composer).toHaveValue('Add the retry button'));

    await user.click(composer);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(agentCreates()).toHaveLength(2));
    expect(agentCreates()[1].body).not.toHaveProperty('share_code_session_with');
    expect(agentCreates()[1].body).toEqual(
      expect.objectContaining({ goal: 'Add the retry button' }),
    );
  });

  it('flag off: the stock row menu has no "New agent in this branch" (nothing can set the share)', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_WIDTH_EXPANDED));
    renderStockSidebar(
      <AppSidebar {...defaultProps({ agents: [makeAgent({ goal: 'Row A' })] })} />,
    );
    const menu = await openRowMenu('Row A');
    expect(within(menu).getByText('Rename')).toBeInTheDocument();
    expect(within(menu).queryByText(/New agent in this branch/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('rose-sidebar')).toBeNull();
  });
});
