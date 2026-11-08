/**
 * Blackbox (RCA 2026-11-06 code-agent view, prod root 1a3d495c "Rose Repo Status"):
 * the code-agent view and its row in the root transcript render through the
 * EXISTING root transcript and query box, from the prod rows of that run
 * (code-agent-view-prod-1a3d495c.fixture.json: the owner's spawn_claude_code_agent
 * and code_transcript rows, credentials redacted).
 *
 *   C2/C4  the code agent's work rows are visible: its "Worked for …" history
 *          expands to its Run rows (task 6f8f8f4d)
 *   C9     one turn reads as ONE "Worked for" row (prod showed "Worked for 35.8s"
 *          twice); a session with no work has none (task 9c3c19a0 showed an
 *          empty "Worked for 1m 42s")
 *   C7     the view is the root MessageList (trajectory-work-group rows)
 *   C10    no "<branch> → main · pushed" / "Committed <sha> on <branch>" rows
 *   C13    no "Session settings unavailable" when the session is not live
 *   C5/C8  root transcript: the code agent is a row inside "Worked for …" with
 *          no Claude card header ("Claude Code Active/Completed", "Cloud",
 *          "Open app", Maximize) and nothing below it
 *   C11    the query box's model chip + speed toggle show the session's model
 *          and speed (recorded CLI init)
 *   C12    the nub shows the session's context window used
 *   C15    a Claude sub-agent (Task tool) running in the code agent shows in the
 *          query box's running-agents drawer
 * Every backend call is served by MSW through the real Terminal (flag on).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import prod from './code-agent-view-prod-1a3d495c.fixture.json';
import { server } from './msw/server';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
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
const OWNER = prod.agent.agent_id;
/** Ran 3 commands in one 35.8s turn (prod S5/S6/S7). */
const WORKED = '6f8f8f4d-c670-4bc8-b5df-e2c785c4a908';
/** Its CLI exited during project startup: no turn, no work (prod S3). */
const NO_WORK = '9c3c19a0-5596-4854-acdc-1685da1ef942';
const PROD_MESSAGES = prod.messages as unknown as Message[];

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

function ownerDetail(messages: Message[]) {
  return {
    agent: {
      agent_id: OWNER,
      goal: prod.agent.goal,
      title: prod.agent.title,
      model: 'rose-labs/rose-1-flash',
      source: 'MAC_APP',
      reasoning_effort: 'medium',
      progress: 1,
      status: 'COMPLETED',
      status_message: null,
      temporal_workflow_id: `wf-${OWNER}`,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      context_size: 0,
      message_count: messages.length,
      price_limit_cents: 1000,
      tree_cost_cents: 4,
      created_at: prod.agent.created_at,
      updated_at: prod.agent.updated_at,
      write_lock_enabled: true,
      parent_agent_id: null,
      parent_goal: null,
      verifier: null,
      tools: [],
    },
    messages,
    pagination: { has_more: false, oldest_timestamp: null },
  };
}

function serveBackend(messages: Message[], sessionStatus = 'CLOSED') {
  server.use(
    http.get(`${API_BASE}/agents`, () =>
      HttpResponse.json({ agents: [ownerDetail(messages).agent] }),
    ),
    http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
    http.get(`${API_BASE}/agents/code-agents`, () => HttpResponse.json({ code_agents: [] })),
    http.get(`${API_BASE}/agents/:agentId`, () => HttpResponse.json(ownerDetail(messages))),
    // A finished session is not live: the capabilities read fails (prod 502).
    http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, () =>
      HttpResponse.json({ error: 'Could not confirm code session capabilities' }, { status: 502 }),
    ),
    http.get(`${API_BASE}/claude-code-session/:taskId`, () =>
      HttpResponse.json({ status: sessionStatus, output: '' }),
    ),
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Andy' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
}

/** One more transcript batch on the WORKED session, in the fixed worker's record shapes. */
function transcriptRow(records: Array<Record<string, unknown>>): Message {
  return {
    message_id: `extra-${String(records[0]?.id)}`,
    timestamp: '2026-11-06T04:24:56.000Z',
    role: 'TOOL',
    text: '',
    metadata: {
      toolCallId: 'toolu_01R3Y6H1bsqRcX12YVmNsMNH',
      toolName: 'spawn_claude_code_agent',
      title: 'Transcript',
      task_id: WORKED,
      action_type: 'code_transcript' as never,
      code_provider: 'claude',
      subAgentId: WORKED,
      isCodeTranscript: true,
      idempotencyKey: `code-transcript:${WORKED}:extra-${String(records[0]?.id)}`,
      code_agent_events: records,
    },
  };
}

async function openCodeAgent(
  taskId: string,
  messages: Message[] = PROD_MESSAGES,
  sessionStatus = 'CLOSED',
) {
  serveBackend(messages, sessionStatus);
  window.history.replaceState({}, '', `/?agent-id=${OWNER}&code-agent=${taskId}`);
  renderWithProviders(<Terminal />);
  return screen.findByTestId('code-agent-view');
}

/** The view's "Worked for …" rows (the root transcript's own work rows). */
function workedRows(scope: HTMLElement): HTMLElement[] {
  return within(scope)
    .queryAllByTestId('trajectory-work-group')
    .filter((group) => /Worked for/.test(group.textContent ?? ''));
}

beforeEach(() => {
  localStorage.clear();
  resetCodeAgentLocalState();
  signInAs(ROSE_DESKTOP_USER_IDS[0]);
  mockProjectsApi([makeProject()]);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

describe('code-agent view renders through the root transcript (prod 1a3d495c)', () => {
  it('C2/C4/C7/C9: one turn is ONE "Worked for" row whose history holds its Run rows', async () => {
    const page = await openCodeAgent(WORKED);
    await within(page).findByText(/Read-only, do not modify code\. In the Rose-Ai-Labs\/rose repo/);
    await waitFor(() => expect(workedRows(page)).toHaveLength(1));
    const [worked] = workedRows(page);
    fireEvent.click(within(worked).getByRole('button', { expanded: false }));
    const history = await within(worked).findByTestId('trajectory-work-history');
    expect(
      within(history).getAllByTestId('trajectory-history-entry').length,
    ).toBeGreaterThanOrEqual(3);
    expect(history.textContent).toContain('git remote get-url origin');
    // The answer follows the work, outside it.
    expect(within(page).getAllByText(/I ran the checks without changing any code/).length).toBe(1);
    expect(history.textContent).not.toContain('I ran the checks without changing any code');
  });

  it('C4/C9: a session whose CLI never ran a turn shows its goal and no empty "Worked for" row', async () => {
    const page = await openCodeAgent(NO_WORK);
    await within(page).findByText(/Read-only\. In the Rose-Ai-Labs\/rose GitHub repo/);
    expect(workedRows(page)).toHaveLength(0);
    expect(page.textContent).not.toMatch(/Worked for/);
  });

  it('C10/C13: no branch/commit rows and no "Session settings unavailable"', async () => {
    const page = await openCodeAgent(WORKED);
    await waitFor(() => expect(workedRows(page)).toHaveLength(1));
    // The query box renders in its own layer (QueryInputLayer), outside the view.
    const box = screen.getByTestId('query-input-host');
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const scope of [page, box]) {
      expect(scope.textContent).not.toMatch(/· pushed/);
      expect(scope.textContent).not.toMatch(/Committed 75d1b1d/);
      expect(scope.textContent).not.toMatch(/Session settings unavailable/);
    }
    expect(screen.queryByTestId('code-agent-session')).toBeNull();
    expect(screen.queryByTestId('code-agent-summary')).toBeNull();
  });

  it('C11/C12/C15: model chip, speed toggle, nub context and Claude sub-agents use the session records', async () => {
    const messages = [
      ...PROD_MESSAGES,
      transcriptRow([
        {
          id: 'session',
          rev: 1,
          seq: 5,
          provider: 'claude',
          ts: '2026-11-06T04:24:18.915Z',
          type: 'session',
          text: '',
          model: 'claude-opus-5-5',
          speed: 'fast',
          effort: 'xhigh',
        },
        {
          id: 'metrics:bb3d324a-29c1-4224-bb7c-0865eea86d6b:190',
          rev: 1,
          seq: 190,
          provider: 'claude',
          ts: '2026-11-06T04:24:54.600Z',
          type: 'metrics',
          usage_scope: 'turn',
          output_tokens: 2436,
          context_tokens: 50_000,
          context_window: 200_000,
        },
        {
          id: 'tool:toolu_task_1',
          rev: 1,
          seq: 191,
          provider: 'claude',
          ts: '2026-11-06T04:24:55.000Z',
          type: 'tool',
          text: 'Audit the open PRs',
          tool: {
            name: 'Task',
            target: 'Audit the open PRs',
            raw_name: 'Task',
            category: 'other',
            activity_kind: 'other',
            result: { status: 'running' },
          },
        },
      ]),
    ];
    // A live session: the sub-agent is running (the spawn row's latest snapshot is live).
    const live = messages.filter(
      (m) => !(m.metadata?.task_id === WORKED && m.metadata?.action_type === 'task_complete'),
    );
    await openCodeAgent(WORKED, live, 'ACTIVE');
    // The query box renders in its own layer (QueryInputLayer), outside the view.
    const composer = await screen.findByTestId('query-input-host');
    await waitFor(() => expect(composer.textContent).toContain('claude-opus-5-5'));
    expect(within(composer).getByTestId('speed-toggle')).not.toHaveAttribute(
      'data-state',
      'normal',
    );
    expect(within(composer).getByTestId('nub-context')).toHaveTextContent('25%');
    const banner = within(composer).getByTestId('background-agents-banner');
    expect(banner).toHaveTextContent('Running 1 agent');
    fireEvent.click(within(banner).getByRole('button', { expanded: false }));
    expect(await within(banner).findByText(/Audit the open PRs/)).toBeInTheDocument();
  });
});

describe("a code agent's own text is never scrubbed by the trajectory copy rule", () => {
  it('thinking and tool output that mention "FastModeToggle" stay verbatim in the view', async () => {
    const mention = 'FastModeToggle is a boolean today; the Fast Mode cache row is unrelated.';
    const messages = [
      ...PROD_MESSAGES,
      transcriptRow([
        {
          id: 'think-fast',
          rev: 1,
          seq: 300,
          provider: 'claude',
          ts: '2026-11-06T04:24:40.000Z',
          type: 'thinking',
          turn_id: 'bb3d324a-29c1-4224-bb7c-0865eea86d6b',
          text: mention,
        },
      ]),
    ];
    const page = await openCodeAgent(WORKED, messages);
    await waitFor(() => expect(workedRows(page)).toHaveLength(1));
    fireEvent.click(within(workedRows(page)[0]).getByRole('button', { expanded: false }));
    // The fixture's own redacted thought has no text: open every Thought row.
    for (const thought of within(page).getAllByText('Thought')) fireEvent.click(thought);
    expect(await within(page).findByText(mention)).toBeInTheDocument();
  });
});

describe('root transcript: the code agent folds into "Worked for …" like any tool (prod 1a3d495c)', () => {
  it('C5/C8: no Claude card header, the row sits in a work group history with no rows below it', async () => {
    serveBackend(PROD_MESSAGES);
    window.history.replaceState({}, '', `/?agent-id=${OWNER}`);
    renderWithProviders(<Terminal />);
    await screen.findByText('the code agent spawns within the gh repo');
    const groups = await screen.findAllByTestId('trajectory-work-group');
    // No top-level card: every code-agent row is inside a work group's history.
    expect(screen.queryAllByTestId('code-agent-chip')).toHaveLength(0);
    for (const group of groups) {
      const toggle = within(group).getAllByRole('button')[0];
      if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
    }
    const rows = await screen.findAllByTestId('code-agent-chip');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.closest('[data-testid="trajectory-work-history"]')).not.toBeNull();
      expect(row.textContent).not.toMatch(/Claude Code (Active|Completed)|Open app|Cloud/);
      expect(row.querySelector('svg.lucide-maximize2')).toBeNull();
      // Nothing under the row: no transcript, composer or branch/commit rows.
      expect(row.nextElementSibling).toBeNull();
    }
    expect(screen.queryByPlaceholderText(/Message Claude Code directly/)).toBeNull();
    expect(screen.queryByText(/Committed 75d1b1d/)).toBeNull();
    expect(screen.queryByText(/· pushed/)).toBeNull();
  });
});
