/**
 * Blackbox: the Rose left-bar code-agent view, second half. Split from
 * rose-code-agent-view.blackbox.tsx to keep each file under the max-lines budget;
 * shared MSW backend and open helpers live in rose-code-agent-view.helpers.tsx.
 * Covers the 2026-10-26 transcript fixes, ended-session sends, return paths
 * (Escape, owner row, other row, Home), the deep link, the 10k read bound,
 * usage-limit pauses and the flag-off account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import * as roseDesktopFlag from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import {
  btcRows,
  chipMessage,
  eventsMessage,
  LIVE_EVENTS,
  msg,
} from './code-agent-steering.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import {
  OTHER,
  API_BASE,
  OWNER,
  TASK,
  liveRows,
  agentRow,
  openFromRow,
  ownerChat,
  ownerCodeAgentRow,
  renderOnOwner,
  requests,
  resetRoseViewState,
  restoreRoseViewState,
  row,
  serveBackend,
  signInAs,
  urlParams,
  view,
} from './rose-code-agent-view.helpers';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const CLOSED_TEXT = 'This code session has finished. Ask Rose to continue the work.';
const USER_PAUSE_TEXT = 'Paused: Codex usage limit reached (resets 3:00 PM). Work is saved.';

beforeEach(() => {
  resetRoseViewState();
});

afterEach(() => {
  restoreRoseViewState();
});

describe('Rose left bar: a code agent opens as its own conversation (flag on)', () => {
  it('Andy 2026-10-26: blur backdrop, root left edge, goal as user prompt, coordination folded, no attribution', async () => {
    serveBackend({ ownerMessages: ownerChat(btcRows(OWNER, TASK)) });
    const user = await renderOnOwner();
    const page = await openFromRow(user);

    // 21: the root transcript's blur backdrop sits behind the view's rows.
    expect(screen.getByTestId('chat-blur-overlay').parentElement?.contains(page)).toBe(true);

    // 22: every row shares the root transcript's left edge (no row insets); the
    // old Finished section (branch line and commit summary) is gone.
    expect(within(page).queryAllByTestId(/^code-agent-(session|summary)$/)).toHaveLength(0);
    expect(page.querySelectorAll('.px-3\\.5, .pl-11, .mx-3, [class*="pl-"]')).toHaveLength(0);

    // 23: Codex's own message reads like a normal assistant message here.
    expect(within(page).getByText('Chart is ready')).toBeInTheDocument();
    expect(within(page).queryByTestId('code-agent-attribution')).toBeNull();

    // 24: the goal renders as the user's prompt; no "Agents coordinating" row;
    // later coordination lives inside the Worked-for slot.
    expect(within(page).queryByTestId('agent-exchange-group')).toBeNull();
    const goal = within(page).getByText('Chart BTC for 24h');
    expect(goal.closest('[data-message-role="USER"]')).not.toBeNull();
    const worked = within(page)
      .getAllByTestId('trajectory-work-group')
      .filter((group) => /Worked for/.test(group.textContent ?? ''));
    expect(worked).toHaveLength(1);
    await user.click(within(worked[0]).getByRole('button', { name: /Worked/ }));
    expect(within(worked[0]).getByTestId('trajectory-work-history')).toHaveTextContent(
      'Use UTC labels',
    );
    // Ended session: nothing shows terminal output, so nothing reads it.
    expect(requests('GET', `/api/codex-code-session/${TASK}`)).toHaveLength(0);
  });

  it('a completed session stays open; a send shows the backend error as one plain line', async () => {
    serveBackend({
      ownerMessages: ownerChat([
        chipMessage({ state: 'completed', ended_at: '2026-10-20T12:04:12.000Z' }),
        eventsMessage(LIVE_EVENTS),
      ]),
      turns: () =>
        HttpResponse.json({ error: CLOSED_TEXT, code: 'CODE_SESSION_CLOSED' }, { status: 409 }),
    });
    const user = await renderOnOwner();
    expect(within(await ownerCodeAgentRow()).getByTestId('code-agent-state')).toHaveTextContent(
      '· Completed',
    );
    const page = await openFromRow(user);
    expect(page).toHaveAttribute('data-code-agent-state', 'completed');
    const groups = within(page).getAllByTestId('trajectory-work-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveAttribute('data-state', 'completed');
    expect(within(groups[0]).getByRole('button', { name: /Worked for/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const input = screen.getByPlaceholderText('Message Codex…');
    await user.type(input, 'One more tweak{Enter}');
    const error = await screen.findByTestId('code-agent-view-error');
    expect(error).toHaveTextContent(CLOSED_TEXT);
    expect(error.textContent).toBe(CLOSED_TEXT);
    expect(error.tagName).toBe('P');
    expect(input).toHaveValue('One more tweak');
    expect(within(page).queryByText('You → Codex:', { exact: false })).toBeNull();
  });

  it('Escape returns to the owner chat and clears the code-agent URL param', async () => {
    const user = await renderOnOwner();
    await openFromRow(user);
    await user.keyboard('{Escape}');
    expect(view()).toBeNull();
    expect(await ownerCodeAgentRow()).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type your message...')).toBeInTheDocument();
    expect(urlParams().get('code-agent')).toBeNull();
    expect(urlParams().get('agent-id')).toBe(OWNER);
    expect(row()).not.toHaveAttribute('aria-current');
  });

  it('the owner row returns without reloading it; another row or the Home + leaves it', async () => {
    const user = await renderOnOwner();
    await openFromRow(user);
    await user.click(screen.getByTestId(`rose-agent-row-${OWNER}`));
    expect(view()).toBeNull();
    // No re-selection: the owner's loaded chat is back at once (a reload would flush
    // it): its prompt and the work group holding the session's row.
    expect(screen.getByText('Polish the speed button')).toBeInTheDocument();
    expect(screen.getAllByTestId('trajectory-work-group').length).toBeGreaterThan(0);
    expect(await ownerCodeAgentRow()).toBeInTheDocument();
    expect(urlParams().get('code-agent')).toBeNull();

    fireEvent.click(row());
    await screen.findByTestId('code-agent-view');
    await user.click(screen.getByTestId(`rose-agent-row-${OTHER}`));
    await waitFor(() => expect(urlParams().get('agent-id')).toBe(OTHER));
    expect(view()).toBeNull();
    expect(urlParams().get('code-agent')).toBeNull();

    // From another agent, the row selects its owner first, then opens.
    fireEvent.click(row());
    expect(await screen.findByTestId('code-agent-view')).toBeInTheDocument();
    expect(urlParams().get('agent-id')).toBe(OWNER);
    const home = within(screen.getByTestId('rose-home-project-row'));
    fireEvent.click(home.getByRole('button', { name: 'Create Super Agent' }));
    expect(view()).toBeNull();
    expect(urlParams().get('code-agent')).toBeNull();
    expect(await screen.findByPlaceholderText('Enter any goal')).toBeInTheDocument();
  });

  it('deep link ?agent-id=<owner>&code-agent=<task> opens the view on load', async () => {
    await renderOnOwner(`/?agent-id=${OWNER}&code-agent=${TASK}`);
    const page = await screen.findByTestId('code-agent-view');
    // No row click: the title is the session's own snapshot title.
    expect(page).toHaveAttribute('aria-label', 'Codex: 3-state speed button');
    const trail = screen.getByRole('navigation', { name: 'Agent breadcrumb' });
    expect(within(trail).getByText('3-state speed button')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(row()).toHaveAttribute('aria-current', 'true'));
  });

  it('a coding breadcrumb preserves a nested owner path and selects a different ancestor', async () => {
    // Detail refreshes return the same persisted message identities.
    const ownerMessages = ownerChat(liveRows());
    const ancestorMessages = [msg({}, { role: 'USER', text: 'Plan a Tahoe weekend' })];
    server.use(
      http.get(`${API_BASE}/agents/${OWNER}`, () =>
        HttpResponse.json({
          agent: {
            ...agentRow(OWNER, 'Polish Rose UI', 1),
            parent_agent_id: OTHER,
            parent_goal: 'Plan Tahoe trip',
            verifier: null,
            tools: [],
          },
          messages: ownerMessages,
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
      http.get(`${API_BASE}/agents/${OTHER}`, () =>
        HttpResponse.json({
          agent: {
            ...agentRow(OTHER, 'Plan Tahoe trip', 2),
            parent_agent_id: null,
            parent_goal: null,
            verifier: null,
            tools: [],
          },
          messages: ancestorMessages,
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
      http.get(`${API_BASE}/agents/${OWNER}/ancestors`, () =>
        HttpResponse.json({
          ancestors: [{ id: OTHER, goal: 'Plan Tahoe trip' }],
        }),
      ),
    );
    const user = await renderOnOwner();
    await openFromRow(user);
    const trail = screen.getByRole('navigation', { name: 'Agent breadcrumb' });
    expect(within(trail).getByRole('button', { name: 'Polish Rose UI' })).toBeInTheDocument();
    await user.click(await within(trail).findByRole('button', { name: 'Plan Tahoe trip' }));
    await waitFor(() => expect(view()).toBeNull());
    expect(urlParams().get('agent-id')).toBe(OTHER);
    expect(urlParams().has('code-agent')).toBe(false);
    expect(await screen.findByText('Plan a Tahoe weekend')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Agent breadcrumb' })).toBeNull();
  });

  it('10k: the view reads only its own session (no list, tree or other agent); none once closed', async () => {
    const user = await renderOnOwner();
    await ownerCodeAgentRow();
    const before = capturedRequests.length;
    fireEvent.click(row());
    await screen.findByTestId('code-agent-view');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const whileOpen = capturedRequests.slice(before).map((r) => new URL(r.url).pathname);
    // Only this session (its own reads) or the owner it already shows.
    const ownRead = (path: string) => path.includes(`/${TASK}`) || path === `/api/agents/${OWNER}`;
    const agentReads = whileOpen.filter((path) => /^\/api\/(agents|[a-z-]*session)/.test(path));
    expect(agentReads.filter((path) => !ownRead(path))).toEqual([]);
    expect(whileOpen).not.toContain('/api/agents/code-agents');
    expect(whileOpen).not.toContain('/api/agents/tree');
    await user.keyboard('{Escape}');
    await ownerCodeAgentRow();
    const closedAt = capturedRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterClose = capturedRequests.slice(closedAt).map((r) => new URL(r.url).pathname);
    expect(afterClose.filter((path) => path.includes('/turns'))).toEqual([]);
  });

  it('usage-limit stop: Paused with the backend text for the user, no Retry', async () => {
    serveBackend({
      ownerMessages: ownerChat([
        chipMessage(),
        msg({
          toolName: 'spawn_claude_code_agent',
          toolCallId: `call-${TASK}`,
          toolStatus: 'FINISHED',
          task_id: TASK,
          action_type: 'task_complete',
          success: false,
          code_provider: 'codex',
          failure_kind: 'usage_limit',
          retryable: true,
          usage_limit: { provider: 'codex', resets_at: '2026-10-20T22:00:00Z' },
          retry: { tool: 'spawn_agent', type: 'code', code_session_id: 'cs-1' },
          code_agent: {
            task_id: TASK,
            provider: 'codex',
            state: 'paused',
            started_at: '2026-10-20T12:00:00.000Z',
            ended_at: '2026-10-20T12:30:00.000Z',
            failure_message: USER_PAUSE_TEXT,
          },
        }),
      ]),
    });
    const user = await renderOnOwner();
    expect(within(await ownerCodeAgentRow()).getByTestId('code-agent-state')).toHaveTextContent(
      '· Paused',
    );
    const page = await openFromRow(user);
    expect(page).toHaveAttribute('data-code-agent-state', 'paused');
    expect(within(page).getByTestId('code-agent-paused-note')).toHaveTextContent(USER_PAUSE_TEXT);
    expect(within(page).getByTestId('code-agent-paused-note').className).not.toMatch(/red/);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(within(page).queryByTestId('code-agent-failure')).toBeNull();
  });
});

describe('code-agent view (flag off)', () => {
  it('an explicitly disabled flag never opens it, even from a deep link', async () => {
    vi.spyOn(roseDesktopFlag, 'isRoseDesktopUser').mockReturnValue(false);
    signInAs('test-user');
    window.history.replaceState({}, '', `/?agent-id=${OWNER}&code-agent=${TASK}`);
    renderWithProviders(<Terminal />);
    await screen.findByPlaceholderText('Type your message...');
    expect(view()).toBeNull();
    expect(screen.queryByTestId(`rose-code-agent-row-${TASK}`)).toBeNull();
    expect(requests('GET', '/api/agents/code-agents')).toHaveLength(0);
  });
});
