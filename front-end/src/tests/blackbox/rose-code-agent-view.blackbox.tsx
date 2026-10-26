/**
 * Blackbox: a code agent opened from the Rose Desktop left bar as its own
 * conversation, through the real Terminal (flag on) with every backend call
 * served by MSW:
 *
 *   GET  /api/agents/code-agents?root_ids=…   → the left-bar rows (W5b batched list)
 *   GET  /api/agents/:ownerId                 → the owner's messages: the session's
 *        spawn_claude_code_agent rows (code_agent snapshot, code_agent_events, …)
 *   POST /api/claude-code-session/:taskId/turns {client_message_id, text, tool_call_id}
 *        → 200 {status:'delivered'} | 409 {error:'This code session has finished…'}
 *
 * Row click → the code agent's view replaces the chat column (header, transcript
 * with no terminal view, the query box as its direct channel); Escape, the owner row,
 * another row or Home return. Deep link ?agent-id=<owner>&code-agent=<task>.
 * 10k agents: opening reads nothing new (the owner's loaded messages); the
 * stock account never opens it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';
import type { CodeAgentListItem } from '@/lib/api/tree';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import * as roseDesktopFlag from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { btcRows } from './code-agent-steering.fixtures';
import { chipMessage, eventsMessage, LIVE_EVENTS, msg } from './code-agent-steering.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { expandBar, makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

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

const API_BASE = 'http://localhost:3001/api';
const OWNER = 'agent-001';
const OTHER = 'agent-002';
const TASK = 'task-1';
const CLOSED_TEXT = 'This code session has finished. Ask Rose to continue the work.';
const USER_PAUSE_TEXT = 'Paused: Codex usage limit reached (resets 3:00 PM). Work is saved.';

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

function agentRow(agentId: string, goal: string, minutesAgo: number) {
  const at = new Date(Date.parse('2026-10-20T12:00:00Z') - minutesAgo * 60_000).toISOString();
  return {
    agent_id: agentId,
    goal,
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 50,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: `wf-${agentId}`,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    context_size: 0,
    message_count: 2,
    price_limit_cents: 100,
    tree_cost_cents: 0,
    created_at: at,
    updated_at: at,
    write_lock_enabled: false,
  };
}

const ROW: CodeAgentListItem = {
  code_agent_id: TASK,
  owner_agent_id: OWNER,
  root_agent_id: OWNER,
  provider: 'codex',
  status: 'ACTIVE',
  title: 'Make the speed button 3-state',
  created_at: '2026-10-20T11:59:30.000Z',
};

function ownerChat(rows: Message[]): Message[] {
  return [msg({}, { role: 'USER', text: 'Polish the speed button' }), ...rows];
}

const liveRows = () => [chipMessage(), eventsMessage(LIVE_EVENTS)];

/** Serves the list, the batched code agents and each agent's detail; captures direct turns. */
function serveBackend({
  ownerMessages = ownerChat(liveRows()),
  turns = () => HttpResponse.json({ status: 'delivered', message_id: 'turn-msg-1' }),
}: {
  ownerMessages?: Message[];
  turns?: () => Response;
} = {}) {
  server.use(
    http.get(`${API_BASE}/agents`, () =>
      HttpResponse.json({
        agents: [agentRow(OWNER, 'Polish Rose UI', 1), agentRow(OTHER, 'Plan Tahoe trip', 2)],
      }),
    ),
    http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
    http.get(`${API_BASE}/agents/code-agents`, () => HttpResponse.json({ code_agents: [ROW] })),
    http.get(`${API_BASE}/agents/:agentId`, ({ params }) => {
      const id = String(params.agentId);
      const own = id === OWNER;
      return HttpResponse.json({
        agent: {
          ...agentRow(id, own ? 'Polish Rose UI' : 'Plan Tahoe trip', 1),
          parent_agent_id: null,
          parent_goal: null,
          verifier: null,
          tools: [],
        },
        messages: own ? ownerMessages : [msg({}, { role: 'USER', text: 'Plan a Tahoe weekend' })],
        pagination: { has_more: false, oldest_timestamp: null },
      });
    }),
    http.post(`${API_BASE}/claude-code-session/:taskId/turns`, turns),
    http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, () =>
      HttpResponse.json({
        effective_settings: { model: 'gpt-test', effort: 'medium', speed: 'standard' },
        models: [
          {
            model: 'gpt-test',
            label: 'Test Codex',
            efforts: ['medium', 'high'],
            speeds: ['standard', 'fast'],
          },
        ],
      }),
    ),
    // The chip's closed-session fallback (owner chat) reads the Codex session once.
    http.get(`${API_BASE}/codex-code-session/:taskId`, () =>
      HttpResponse.json({ status: 'RUNNING', output: '' }),
    ),
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Test User' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
}

function requests(method: string, path: string) {
  return capturedRequests.filter((r) => r.method === method && new URL(r.url).pathname === path);
}

function urlParams() {
  return new URL(window.location.href).searchParams;
}

const row = () => screen.getByTestId(`rose-code-agent-row-${TASK}`);
const view = () => screen.queryByTestId('code-agent-view');

/** The real Terminal on the owner agent (its chat holds the session's chip). */
async function renderOnOwner(route = `/?agent-id=${OWNER}`) {
  window.history.replaceState({}, '', route);
  const user = userEvent.setup({ delay: null });
  renderWithProviders(<Terminal />);
  await screen.findByTestId('rose-sidebar');
  expandBar();
  const ownerRow = await screen.findByTestId(`rose-agent-row-${OWNER}`);
  const branch = ownerRow.closest('[data-agent-depth]') as HTMLElement;
  const disclosure = await within(branch).findByRole('button', { name: /^Expand|^Collapse/ });
  if (disclosure.getAttribute('aria-expanded') === 'false') fireEvent.click(disclosure);
  await screen.findByTestId(`rose-code-agent-row-${TASK}`);
  return user;
}

async function openFromRow(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId('code-agent-chip');
  expandBar();
  fireEvent.click(row());
  return screen.findByTestId('code-agent-view');
}

beforeEach(() => {
  localStorage.clear();
  resetCodeAgentLocalState();
  signInAs(ROSE_DESKTOP_USER_IDS[0]);
  mockProjectsApi([makeProject()]);
  serveBackend();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('Rose left bar: a code agent opens as its own conversation (flag on)', () => {
  it('row click replaces the chat column with its header, transcript and direct query box', async () => {
    const user = await renderOnOwner();
    const page = await openFromRow(user);
    const header = within(page).getByTestId('code-agent-view-header');
    expect(within(header).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    expect(within(header).getByTestId('code-agent-view-title')).toHaveTextContent(
      'Make the speed button 3-state',
    );
    expect(within(header).getByTestId('code-agent-view-target')).toHaveTextContent(
      'Cloud · rose-ui/polish/speed',
    );
    expect(within(header).getByTestId('code-agent-view-state')).toHaveTextContent('Running');

    // The full transcript: thinking, assistant message, tool rows.
    const transcript = within(page).getByTestId('code-agent-transcript');
    expect(within(transcript).getAllByTestId('code-work-slot')).toHaveLength(1);
    expect(transcript).toHaveTextContent('Explored 1 file, edited 1 file, ran 1 command');
    expect(transcript.querySelectorAll('[data-message-id]')).toHaveLength(1);
    await user.click(within(transcript).getByRole('button', { name: /Working/ }));
    expect(transcript).toHaveTextContent('widen the existing toggle to three states');
    // The page transcript grows with the column (no 300px chip cap).
    expect(transcript.className).not.toContain('max-h-[300px]');
    // No terminal view: no Transcript / Terminal tabs and no terminal surface.
    expect(within(page).queryByRole('tablist')).toBeNull();
    expect(within(page).queryByRole('tab', { name: 'Terminal' })).toBeNull();
    expect(page.querySelector('.code-agent-terminal-mount')).toBeNull();
    expect(transcript.closest('.hidden')).toBeNull();

    // The owner's chat is replaced (its chip and composer are gone).
    expect(screen.queryByTestId('code-agent-chip')).toBeNull();
    expect(screen.queryByPlaceholderText('Type your message...')).toBeNull();
    const box = within(screen.getByTestId('query-input-layer'));
    expect(box.getByPlaceholderText('Message Codex…')).toBeInTheDocument();
    // Text only: no nub tab, pinned tools, model selector or paperclip.
    expect(box.queryByTestId('query-toolbar-nub')).toBeNull();
    expect(box.queryByTestId('query-pinned-tools')).toBeNull();
    expect(box.getByRole('button', { name: 'Attach files' })).toBeInTheDocument();
    expect(urlParams().get('agent-id')).toBe(OWNER);
    expect(urlParams().get('code-agent')).toBe(TASK);
  });

  it('marks the open code-agent row by weight/color; its owner row is not marked', async () => {
    const user = await renderOnOwner();
    expandBar();
    const owner = screen.getByTestId(`rose-agent-row-${OWNER}`);
    expect(owner).toHaveAttribute('aria-current', 'true');
    expect(row()).not.toHaveAttribute('aria-current');
    await openFromRow(user);
    expect(row()).toHaveAttribute('aria-current', 'true');
    expect(row().className).toContain('font-semibold');
    expect(row().className).toContain('dark:text-[#ecece8]');
    // No fill/ring around the selected row (selection = color/weight only).
    expect(row().className).not.toMatch(/\bbg-|ring-/);
    expect(screen.getByTestId(`rose-agent-row-${OWNER}`)).not.toHaveAttribute('aria-current');
  });

  it('a message from the query box goes to the steer route and appears in the transcript', async () => {
    const user = await renderOnOwner();
    await openFromRow(user);
    const input = screen.getByPlaceholderText('Message Codex…');
    await user.type(input, 'Keep the 26px button{Enter}');
    await waitFor(() =>
      expect(requests('POST', `/api/claude-code-session/${TASK}/turns`)).toHaveLength(1),
    );
    const [turn] = requests('POST', `/api/claude-code-session/${TASK}/turns`);
    expect(turn.body).toEqual({
      client_message_id: expect.stringMatching(/^turn-/),
      text: 'Keep the 26px button',
      tool_call_id: `call-${TASK}`,
    });
    const transcript = screen.getByTestId('code-agent-transcript');
    await within(transcript).findByText('Keep the 26px button');
    expect(
      within(transcript).getByText('Keep the 26px button').closest('[data-message-role]'),
    ).toHaveAttribute('data-message-role', 'USER');
    expect(input).toHaveValue('');
    // Straight to the session: the owner Rose agent gets no chat message.
    expect(requests('POST', `/api/agents/${OWNER}/messages`)).toHaveLength(0);
  });

  it('keeps attachments and settings draft through failed delivery, then applies native ACK', async () => {
    const file = {
      id: 'uploaded-fe16',
      storage_path: 'user/notes.txt',
      original_filename: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: 5,
      created_at: '2026-10-20T12:00:00Z',
    };
    let attempts = 0;
    serveBackend({
      turns: () =>
        ++attempts === 1
          ? HttpResponse.json({ error: 'Native turn unavailable' }, { status: 503 })
          : HttpResponse.json({
              status: 'delivered',
              delivery_mode: 'steer',
              turn_id: 'native-1',
              effective_settings: { model: 'gpt-test', effort: 'high', speed: 'fast' },
            }),
    });
    server.use(http.post(`${API_BASE}/upload`, () => HttpResponse.json({ file_pointer: file })));
    const user = await renderOnOwner();
    await openFromRow(user);
    const composer = screen.getByTestId('code-agent-view-composer');
    await user.selectOptions(await screen.findByLabelText('Reasoning effort'), 'high');
    await user.selectOptions(screen.getByLabelText('Code speed'), 'fast');
    await user.upload(
      screen
        .getByTestId('query-input-layer')
        .querySelector('input[type="file"]') as HTMLInputElement,
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    );
    await screen.findByText('notes.txt');
    const input = screen.getByPlaceholderText('Message Codex…');
    await user.type(input, 'Inspect this{Enter}');
    await screen.findByText('Native turn unavailable');
    expect(input).toHaveValue('Inspect this');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(within(composer).getByRole('status')).toHaveTextContent('medium · standard');
    await user.keyboard('{Escape}');
    await openFromRow(user);
    expect(screen.getByPlaceholderText('Message Codex…')).toHaveValue('Inspect this');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    await user.click(screen.getByPlaceholderText('Message Codex…'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByPlaceholderText('Message Codex…')).toHaveValue(''));
    const turns = requests('POST', `/api/claude-code-session/${TASK}/turns`);
    expect(turns).toHaveLength(2);
    expect((turns[1].body as Record<string, unknown>).client_message_id).toBe(
      (turns[0].body as Record<string, unknown>).client_message_id,
    );
    expect(turns[1].body).toMatchObject({
      attachments: [file],
      reasoning_effort: 'high',
      speed: 'fast',
    });
    expect(screen.queryByText('notes.txt')).toBeNull();
    expect(
      within(screen.getByTestId('code-agent-view-composer')).getByRole('status'),
    ).toHaveTextContent('high · fast');
  });

  it('keeps the composer intact below a native approval and resolves the exact request', async () => {
    serveBackend({
      ownerMessages: ownerChat([
        ...liveRows(),
        msg(
          {
            task_id: TASK,
            toolName: 'request_user_approval',
            toolCallId: 'native-approval-call',
            toolStatus: 'IN_PROGRESS',
            isUserAttentionMessage: true,
            requestingAgent: {
              kind: 'code_agent',
              task_id: TASK,
              agent_id: OWNER,
              label: 'Codex',
              provider: 'codex',
            },
            requestUserApproval: { toolApproval: true, attentionRequestId: 'native-approval-1' },
          },
          { text: 'Allow this command?' },
        ),
      ]),
    });
    server.use(
      http.post(`${API_BASE}/attention-requests/native-approval-1/respond`, () =>
        HttpResponse.json({ success: true }),
      ),
    );
    const user = await renderOnOwner();
    await openFromRow(user);
    const composer = screen.getByPlaceholderText('Message Codex…');
    await user.type(composer, 'Keep this draft');
    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(
      accept.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(accept);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
    expect(composer).toHaveValue('Keep this draft');
    expect(requests('POST', '/api/attention-requests/native-approval-1/respond')).toHaveLength(1);
    expect(requests('POST', `/api/claude-code-session/${TASK}/turns`)).toHaveLength(0);
  });

  it.each(['claude', 'codex'] as const)(
    'shows real %s stream counters with the existing indicator',
    async (provider) => {
      const start = '2026-10-20T12:00:00.000Z';
      const scope = provider === 'claude' ? 'turn' : 'session';
      serveBackend({
        ownerMessages: ownerChat([
          chipMessage({ provider }),
          eventsMessage([
            {
              id: 'native-start',
              type: 'turn',
              event: 'started',
              turn_id: 'native-stream',
              ts: start,
              turn_started_at: start,
            },
            {
              id: 'partial-answer',
              type: 'message',
              partial: true,
              turn_id: 'native-stream',
              ts: '2026-10-20T12:00:01.000Z',
              text: 'Live native answer',
            },
            {
              id: 'metric-1',
              type: 'metrics',
              turn_id: 'native-stream',
              usage_scope: scope,
              output_tokens: 100,
              ts: '2026-10-20T12:00:02.000Z',
            },
            {
              id: 'metric-2',
              type: 'metrics',
              turn_id: 'native-stream',
              usage_scope: scope,
              output_tokens: 120,
              ts: '2026-10-20T12:00:04.000Z',
            },
          ]),
        ]),
      });
      const user = await renderOnOwner();
      await openFromRow(user);
      const indicator = screen.getByTestId('thinking-indicator');
      expect(indicator).toHaveTextContent('Streaming');
      expect(indicator).toHaveTextContent(provider === 'claude' ? '120 tokens' : '20 tokens');
      expect(indicator).toHaveTextContent('10.0 tok/s');
      expect(
        screen.getByText('Live native answer').closest('[data-message-state]'),
      ).toHaveAttribute('data-message-state', 'streaming');
    },
  );

  it('a resumed Codex stream has no invented zero counter or rate before its next native sample', async () => {
    serveBackend({
      ownerMessages: ownerChat([
        chipMessage(),
        eventsMessage([
          {
            id: 'start',
            type: 'turn',
            event: 'started',
            turn_id: 'resumed',
            ts: '2026-10-20T12:00:00.000Z',
          },
          {
            id: 'thinking',
            type: 'thinking',
            partial: true,
            text: 'Thinking about the task',
            turn_id: 'resumed',
            ts: '2026-10-20T12:00:01.000Z',
          },
          {
            id: 'metric',
            type: 'metrics',
            usage_scope: 'session',
            output_tokens: 12000,
            turn_id: 'resumed',
            ts: '2026-10-20T12:00:02.000Z',
          },
        ]),
      ]),
    });
    const user = await renderOnOwner();
    await openFromRow(user);
    const indicator = screen.getByTestId('thinking-indicator');
    expect(indicator).toHaveTextContent('Thinking');
    expect(indicator).not.toHaveTextContent(/tokens|tok\/s/);
  });

  it('Andy 2026-10-26: blur backdrop, root left edge, goal as user prompt, coordination folded, no attribution', async () => {
    serveBackend({ ownerMessages: ownerChat(btcRows(OWNER, TASK)) });
    const user = await renderOnOwner();
    const page = await openFromRow(user);

    // 21: the root transcript's blur backdrop sits behind the view's rows.
    expect(screen.getByTestId('chat-blur-overlay').parentElement?.contains(page)).toBe(true);

    // 22: every row shares the root transcript's left edge (no row insets),
    // including the Finished section (branch line and commit summary).
    expect(within(page).getAllByTestId(/^code-agent-(session|summary)$/)).toHaveLength(2);
    expect(page.querySelectorAll('.px-3\\.5, .pl-11, .mx-3, [class*="pl-"]')).toHaveLength(0);

    // 23: Codex's own message reads like a normal assistant message here.
    expect(within(page).getByText('Chart is ready')).toBeInTheDocument();
    expect(within(page).queryByTestId('code-agent-attribution')).toBeNull();

    // 24: the goal renders as the user's prompt; no "Agents coordinating" row;
    // later coordination lives inside the Worked-for slot.
    expect(within(page).queryByTestId('agent-exchange-group')).toBeNull();
    const goal = within(page).getByText('Chart BTC for 24h');
    expect(goal.closest('[data-message-role="USER"]')).not.toBeNull();
    const slot = within(page).getByTestId('code-work-slot');
    await user.click(within(slot).getByRole('button', { name: /Worked/ }));
    expect(within(slot).getByText('Use UTC labels')).toBeInTheDocument();
    // Ended session: nothing shows terminal output, so nothing reads it.
    expect(requests('GET', `/codex-code-session/${TASK}`)).toHaveLength(0);
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
    const page = await openFromRow(user);
    expect(within(page).getByTestId('code-agent-view-state')).toHaveTextContent('Completed');
    expect(within(page).getAllByTestId('code-work-slot')).toHaveLength(1);
    expect(within(page).getByRole('button', { name: /Worked/ })).toHaveAttribute(
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
    expect(await screen.findByTestId('code-agent-chip')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type your message...')).toBeInTheDocument();
    expect(urlParams().get('code-agent')).toBeNull();
    expect(urlParams().get('agent-id')).toBe(OWNER);
    expect(row()).not.toHaveAttribute('aria-current');
  });

  it('the owner row returns without reloading it; another row or Home leaves it', async () => {
    const user = await renderOnOwner();
    await openFromRow(user);
    await user.click(screen.getByTestId(`rose-agent-row-${OWNER}`));
    expect(view()).toBeNull();
    // No re-selection: the owner's loaded chat is back at once (a reload would flush it).
    expect(screen.getByTestId('code-agent-chip')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(view()).toBeNull();
    expect(urlParams().get('code-agent')).toBeNull();
    expect(await screen.findByPlaceholderText('Enter any goal')).toBeInTheDocument();
  });

  it('deep link ?agent-id=<owner>&code-agent=<task> opens the view on load', async () => {
    await renderOnOwner(`/?agent-id=${OWNER}&code-agent=${TASK}`);
    const page = await screen.findByTestId('code-agent-view');
    // No row click: the title is the session's own snapshot title.
    expect(within(page).getByTestId('code-agent-view-title')).toHaveTextContent(
      '3-state speed button',
    );
    await waitFor(() => expect(row()).toHaveAttribute('aria-current', 'true'));
  });

  it('10k: the view reads only its own session (no list, tree or other agent); none once closed', async () => {
    const user = await renderOnOwner();
    await screen.findByTestId('code-agent-chip');
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
    await screen.findByTestId('code-agent-chip');
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
    const page = await openFromRow(user);
    expect(within(page).getByTestId('code-agent-view-state')).toHaveTextContent('Paused');
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
