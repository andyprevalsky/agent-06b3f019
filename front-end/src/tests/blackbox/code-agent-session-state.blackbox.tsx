/**
 * Blackbox: the desktop code-agent row and view on the W5b persistent-session
 * contract (feat/rose-user-ui @ f78bf8aa8; agents/domains/spawn_claude_code_agent
 * handler.py + service.py build_code_agent_metadata).
 *
 * Redesign (2026-11-06, user-approved): the root keeps ONE plain code-agent row
 * ("<title> · Running|Completed|Failed|Paused" + elapsed) that folds into the
 * root's "Worked for …" history; a click opens the code-agent view. The provider
 * header ("Claude Code Paused"), Maximize, in-row note / failure box and the
 * branch / commit rows are gone from the root. The view (CodeAgentConversationView)
 * holds the FailureBox and the PausedNote above the transcript.
 *
 *   code_agent.state 'paused'  idle pause, user pause or waiting on the parent:
 *                              resumable, shown as paused, never failed/red.
 *   C15 usage limit            the spawn's final row carries failure_kind
 *                              'usage_limit', retryable, usage_limit{provider},
 *                              retry{tool, type, code_session_id}; the activity's
 *                              own row has action_type 'usage_limit'. The row reads
 *                              "· Paused" (an older 'failed' state corrected) and
 *                              the view shows one muted line with the backend's
 *                              text for the user: code_agent.failure_message when
 *                              the producer wrote state 'paused', else the
 *                              usage_limit details (never the parent's retry
 *                              instruction). No Retry button: there is no
 *                              user-callable retry/resume route.
 *   code_session / summary     branch → merge target · pushed · PR · merged and
 *                              "Committed <sha> on <branch>" are NOT rendered any
 *                              more (user: "rm this random jank"): the same
 *                              fixtures prove the root and the view show none of it.
 *
 * Flag off keeps the stock chip for the same rows.
 */
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { CodeAgentConversationView } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentConversationView';
import type { OpenCodeAgent } from '@/features/terminal-component-group/components/code-agent-view/codeAgentViewState';
import { usageLimitDetails } from '@/features/terminal-component-group/hooks/codeAgentContract';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';

import {
  API_BASE,
  chipMessage,
  codeAgent,
  msg,
  renderChip,
  renderChipWithView,
  ROOT_AGENT_ID,
  signIn,
  WithAgent,
} from './code-agent-steering.fixtures';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const { fetchSession } = vi.hoisted(() => ({ fetchSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/terminal-component-group/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/terminal-component-group/api')>()),
  fetchCodeAgentSession: fetchSession,
}));
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

const SESSION_ID = '5b1f0a52-8f3e-4f0c-9d43-2c6a1f2b7e10';

/** `metadata.code_session` as _merge_close_code_session_facts writes it. */
function codeSession(overrides: Record<string, unknown> = {}) {
  return {
    code_session_id: SESSION_ID,
    branch: 'rose/task-speed',
    base_branch: 'main',
    merge_target: 'rose-ui/polish',
    parent_code_session_id: null,
    resumed_from: null,
    state: 'paused',
    checkpoint_seq: 3,
    head: 'c0ffee1234',
    local_commits: 2,
    pushed: true,
    dirty_files: 0,
    files: [{ path: 'front-end/src/Speed.tsx', added: 12, removed: 3 }],
    pr: { number: 12, url: 'https://github.test/rose/pull/12', state: 'open', merged: false },
    merged: false,
    merge_target_contains_head: false,
    ...overrides,
  };
}

/** `metadata.code_agent` as build_code_agent_metadata writes it for a closed task. */
function closedCodeAgent(state: string, overrides: Record<string, unknown> = {}) {
  return codeAgent({
    provider: 'claude',
    branch: 'rose/task-speed',
    base_branch: 'rose-ui/polish',
    state,
    started_at: '2026-10-20T12:00:00Z',
    ended_at: '2026-10-20T12:03:05Z',
    summary: {
      commit: 'c0ffee1234',
      branch: 'rose/task-speed',
      files: [{ path: 'front-end/src/Speed.tsx', added: 12, removed: 3 }],
    },
    ...overrides,
  });
}

/** The spawn handler's final task_complete row (completed_metadata). */
function finalRow(extra: Record<string, unknown>) {
  return msg(
    {
      toolName: 'spawn_claude_code_agent',
      toolCallId: 'call-task-1',
      toolStatus: 'FINISHED',
      task_id: 'task-1',
      action_type: 'task_complete',
      success: false,
      structured_response: null,
      code_provider: 'claude',
      completed_turns: null,
      ...extra,
    },
    { text: 'Code session paused' },
  );
}

const USAGE_LIMIT_TEXT =
  "Code agent stopped: the Claude Code usage limit was reached (resets 2026-10-20T15:00:00Z). Its work is saved on branch rose/task-speed (checkpoint 3). Retry now with spawn_agent(type='code', code_session_id='5b1f0a52-8f3e-4f0c-9d43-2c6a1f2b7e10', goal=<the same goal>)";
/** The user's line the paused producer writes (format_usage_limit_user_message). */
const USER_PAUSE_TEXT = 'Paused: Claude usage limit reached (resets 3:00 PM). Work is saved.';
const RESETS_AT = '2026-10-20T15:00:00Z';

function usageLimitRow(provider: 'claude' | 'codex') {
  return finalRow({
    code_provider: provider,
    code_session: codeSession(),
    code_agent: closedCodeAgent('failed', { provider, failure_message: USAGE_LIMIT_TEXT }),
    failure_kind: 'usage_limit',
    retryable: true,
    usage_limit: {
      provider,
      resets_at: '2026-10-20T15:00:00Z',
      limit_type: 'five_hour',
      credential_marked: true,
    },
    retry: { tool: 'spawn_agent', type: 'code', code_session_id: SESSION_ID },
  });
}

/** The code-agent view of task-1 as the Terminal opens it (owner = the root chat). */
function renderView(messages: Message[], provider: 'claude' | 'codex' = 'claude') {
  const codeAgent: OpenCodeAgent = {
    taskId: 'task-1',
    ownerAgentId: ROOT_AGENT_ID,
    provider,
    title: '3-state speed button',
    status: null,
  };
  const rendered = renderWithProviders(
    <WithAgent messages={messages}>
      <CodeAgentConversationView codeAgent={codeAgent} readOnlyMessage={null} />
    </WithAgent>,
  );
  return { ...rendered, view: screen.getByTestId('code-agent-view') };
}

/** Expands every collapsed "Worked for …" group in scope (root rows sit inside one). */
function expandWork(scope: HTMLElement) {
  for (const group of within(scope).queryAllByTestId('trajectory-work-group')) {
    const toggle = within(group).getAllByRole('button')[0];
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
}

/** The row's state word ("· Running|Completed|Failed|Paused"). */
const stateWord = (row: HTMLElement) => within(row).getByTestId('code-agent-state');

const STATE_WORD = { live: 'Running', paused: 'Paused', completed: 'Completed', failed: 'Failed' };
type RowState = keyof typeof STATE_WORD;

/** The branch / pushed / PR / commit facts the redesign removed (user: "rm this random jank"). */
const REMOVED_FACTS =
  /rose\/task-speed|rose-ui\/polish|c0ffee|→|pushed|PR #12|merged|Committed|Speed\.tsx/;

/**
 * The root row alone: its state and state word (red only when failed), and none of
 * what the redesign moved into the view (failure box, pause note) or removed
 * (retry, branch / commit rows).
 */
function expectRow(messages: Message[], state: RowState, elapsed?: string) {
  const root = renderChip(messages);
  const row = screen.getByTestId('code-agent-chip');
  expect(row).toHaveAttribute('data-code-agent-state', state);
  expect(stateWord(row)).toHaveTextContent(new RegExp(`^· ${STATE_WORD[state]}$`));
  // Red only on a real failure: the state word alone carries it; the row and its glyphs never do.
  expect(stateWord(row).classList.contains('text-red-600')).toBe(state === 'failed');
  expect(within(row).queryAllByText(/Failed/)).toHaveLength(state === 'failed' ? 1 : 0);
  expect(row.className).not.toMatch(/red/);
  expect(row.querySelector('svg.text-red-500')).toBeNull();
  for (const id of ['failure', 'paused-note', 'session', 'summary', 'file']) {
    expect(within(row).queryByTestId(`code-agent-${id}`)).toBeNull();
  }
  expect(within(row).queryByRole('button', { name: /retry/i })).toBeNull();
  expect(row.textContent).not.toMatch(REMOVED_FACTS);
  if (elapsed) expect(within(row).getByTestId('code-agent-elapsed')).toHaveTextContent(elapsed);
  root.unmount();
}

interface ViewExpectation {
  provider?: 'claude' | 'codex';
  /** The backend's failure text, verbatim in the red box (none when absent). */
  failure?: string;
  /** The one muted paused line, verbatim (none when absent). */
  note?: string;
}

/** The view over the same rows: its state and exactly the failure box / pause note given. */
function expectView(messages: Message[], state: RowState, expected: ViewExpectation = {}) {
  const { view } = renderView(messages, expected.provider);
  expect(view).toHaveAttribute('data-code-agent-state', state);
  const box = within(view).queryByTestId('code-agent-failure');
  expect(box?.textContent).toBe(expected.failure);
  const redBoxes = view.querySelectorAll('.border-red-500\\/30').length;
  expect(redBoxes).toBe(box ? 1 : 0);
  const note = within(view).queryByTestId('code-agent-paused-note');
  expect(note?.textContent).toBe(expected.note);
  expect(note?.className ?? '').not.toMatch(/red/);
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  expect(screen.queryByTestId('code-agent-session')).toBeNull();
  return view;
}

/** Neither a scope's session testids, PR link nor text carry the removed session facts. */
function expectNoSessionFacts(scope: HTMLElement) {
  for (const id of ['session', 'summary', 'file']) {
    expect(within(scope).queryByTestId(`code-agent-${id}`)).toBeNull();
  }
  expect(within(scope).queryByRole('link', { name: /PR #12/ })).toBeNull();
  expect(scope.textContent).not.toMatch(REMOVED_FACTS);
}

/**
 * Neither the root transcript (its "Worked for …" group expanded, the row inside
 * it) nor the code-agent view renders the session facts or the commit summary.
 */
function expectSessionFactsGone(messages: Message[]) {
  const root = renderWithProviders(
    <WithAgent messages={messages}>
      <MessageList />
    </WithAgent>,
  );
  expandWork(root.container);
  const row = within(root.container).getByTestId('code-agent-chip');
  expect(row.closest('[data-testid="trajectory-work-history"]')).not.toBeNull();
  expectNoSessionFacts(root.container);
  root.unmount();
  expectNoSessionFacts(renderView(messages).view);
}

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
  // A view reads the session's model catalog; unreachable here (prod 502 shape).
  server.use(
    http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, () =>
      HttpResponse.json({ error: 'Could not confirm code session capabilities' }, { status: 502 }),
    ),
  );
});

describe('W5b: paused code sessions', () => {
  it('an idle-paused session reads "· Paused" in a muted state word, never failed or red', () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      finalRow({
        session_paused: true,
        code_session: codeSession(),
        code_agent: closedCodeAgent('paused'),
      }),
    ];
    expectRow(messages, 'paused', '3m 05s');
    expectView(messages, 'paused');
  });

  it("the activity's session_paused row alone (no task_complete yet) is already paused", () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      msg({
        toolName: 'spawn_claude_code_agent',
        toolCallId: 'call-task-1',
        toolStatus: 'FINISHED',
        task_id: 'task-1',
        action_type: 'session_paused',
        code_provider: 'claude',
        code_session: codeSession(),
        code_agent: closedCodeAgent('paused'),
      }),
    ]);
    expect(screen.getByTestId('code-agent-chip')).toHaveAttribute(
      'data-code-agent-state',
      'paused',
    );
  });

  it('clicking the row opens the code-agent view (never a terminal); the row stays Paused', async () => {
    const open = vi.fn();
    const { container } = renderChipWithView(
      [chipMessage({ provider: 'claude' }), finalRow({ code_agent: closedCodeAgent('paused') })],
      open,
    );
    const chip = screen.getByTestId('code-agent-chip');
    expect(screen.queryByRole('button', { name: 'Maximize Claude Code' })).toBeNull();
    await userEvent.setup().click(chip);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        ownerAgentId: 'root-agent-1',
        provider: 'claude',
      }),
    );
    expect(document.querySelector('.code-agent-terminal-mount')).toBeNull();
    expect(container.querySelector('.code-agent-terminal-mount')).toBeNull();
    expect(chip).toHaveAttribute('data-code-agent-state', 'paused');
    expect(stateWord(chip)).toHaveTextContent(/^· Paused$/);
    expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
  });

  it('an ended desktop session never reads the saved terminal output (nothing shows it)', async () => {
    renderChipWithView(
      [chipMessage({ provider: 'claude' }), finalRow({ code_agent: closedCodeAgent('completed') })],
      vi.fn(),
    );
    expect(screen.getByTestId('code-agent-chip')).toHaveAttribute(
      'data-code-agent-state',
      'completed',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSession).not.toHaveBeenCalled();
  });

  it('a pending task id offers no way to open the view (the row is not a button)', async () => {
    const open = vi.fn();
    const pending = { task_id: 'pending' };
    renderChipWithView(
      [
        chipMessage({ provider: 'claude', ...pending }),
        finalRow({ ...pending, code_agent: closedCodeAgent('paused', pending) }),
      ],
      open,
      'pending',
    );
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).not.toHaveAttribute('role', 'button');
    expect(chip).not.toHaveAttribute('tabindex');
    expect(screen.queryByRole('button', { name: 'Maximize Claude Code' })).toBeNull();
    await userEvent.setup().click(chip);
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(open).not.toHaveBeenCalled();
  });

  it("paused: the note renders flush in the view's column (no pl-11 inset); the row has no note and there is no session line", () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      finalRow({
        code_session: codeSession(),
        code_agent: closedCodeAgent('paused', { failure_message: 'Paused by you' }),
      }),
    ];
    expectRow(messages, 'paused');
    const view = expectView(messages, 'paused', { note: 'Paused by you' });
    const note = within(view).getByTestId('code-agent-paused-note');
    expect(note.className).not.toContain('pl-11');
    // Same column as the transcript below it, not nested in an inset wrapper.
    expect(note.parentElement).toBe(view);
  });

  it('a snapshot-driven chip opens no terminal WebSocket (stock flag-off chip still does)', () => {
    const opened: string[] = [];
    const Original = window.WebSocket;
    window.WebSocket = class {
      constructor(url: string) {
        opened.push(url);
      }
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    } as unknown as typeof WebSocket;
    const renderLive = (roseDesktop: boolean) =>
      renderWithProviders(
        createElement(
          WithAgent,
          { messages: [chipMessage()] },
          createElement(ClaudeCodeChip, { taskId: 'task-1', wsUrl: 'wss://term.rose.test/x' }),
        ),
        { roseDesktop },
      );
    try {
      const live = renderLive(true);
      expect(screen.getByTestId('code-agent-chip')).toBeInTheDocument();
      expect(opened).toEqual([]);
      live.unmount();
      renderLive(false);
      expect(opened).toEqual(['wss://term.rose.test/x']);
    } finally {
      window.WebSocket = Original;
    }
  });

  it('without a code-agent view provider the desktop row is not clickable and offers no Maximize', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({ code_agent: closedCodeAgent('paused') }),
    ]);
    expect(screen.getByTestId('code-agent-chip')).not.toHaveAttribute('role', 'button');
    expect(screen.queryByRole('button', { name: 'Maximize Claude Code' })).toBeNull();
  });

  it('a later live snapshot (resumed session) outranks an earlier pause', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      msg({
        toolName: 'spawn_claude_code_agent',
        task_id: 'task-1',
        action_type: 'session_paused',
        code_agent: closedCodeAgent('paused'),
      }),
      msg({
        toolName: 'spawn_claude_code_agent',
        task_id: 'task-1',
        action_type: 'claude_code_started',
        code_agent: { state: 'live' },
      }),
    ]);
    expect(screen.getByTestId('code-agent-chip')).toHaveAttribute('data-code-agent-state', 'live');
  });

  it('flag off: the stock chip renders and nothing says Paused', () => {
    renderChip(
      [chipMessage({ provider: 'claude' }), finalRow({ code_agent: closedCodeAgent('paused') })],
      false,
    );
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByText(/Paused/)).not.toBeInTheDocument();
  });

  it('a user pause (activity "Session Cancelled" paused row, then the handler ERROR cancel row) stays paused', () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      msg(
        {
          toolName: 'spawn_claude_code_agent',
          toolCallId: 'call-task-1',
          toolStatus: 'FINISHED',
          title: 'Session Cancelled',
          task_id: 'task-1',
          action_type: 'task_complete',
          code_provider: 'claude',
          code_agent: closedCodeAgent('paused'),
        },
        { text: 'Agent paused by user' },
      ),
      // handler.py cancel_metadata: success False, status ERROR, target-only code_agent.
      msg(
        {
          toolName: 'spawn_claude_code_agent',
          toolStatus: 'ERROR',
          title: 'Claude Code Session Cancelled',
          task_id: 'task-1',
          action_type: 'task_complete',
          success: false,
          code_provider: 'claude',
          code_agent: { target: 'cloud' },
        },
        { text: 'User paused the agent' },
      ),
    ];
    expectRow(messages, 'paused');
    expectView(messages, 'paused');
  });
});

describe('terminal rows: a real success never reads as failed', () => {
  it('the real success row (handler completed_metadata) reads "· Completed" with its duration and no summary rows', () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      msg(
        {
          toolName: 'spawn_claude_code_agent',
          toolCallId: 'call-task-1',
          toolStatus: 'FINISHED',
          title: '✓ Task Completed',
          task_id: 'task-1',
          action_type: 'task_complete',
          success: true,
          structured_response: null,
          code_provider: 'claude',
          completed_turns: null,
          code_session: codeSession({ state: 'closed' }),
          code_agent: closedCodeAgent('completed'),
        },
        { text: 'Committed c0ffee1 on rose/task-speed.' },
      ),
    ];
    expectRow(messages, 'completed', '3m 05s');
    expectView(messages, 'completed');
  });

  it('an explicit completed snapshot without a success flag (visual fixture) is not re-read as failed', () => {
    const messages = [
      msg(
        {
          toolName: 'spawn_claude_code_agent',
          toolCallId: 'call-task-1',
          task_id: 'task-1',
          action_type: 'task_complete',
          toolStatus: 'FINISHED',
          code_provider: 'claude',
          code_agent: closedCodeAgent('completed', {
            title: 'nub tab behind the query box',
            summary: undefined,
          }),
        },
        { text: 'Committed a41c9e2 on rose-ui/polish/nub; tests 38/38 passed.' },
      ),
    ];
    expectRow(messages, 'completed');
    expectView(messages, 'completed');
  });

  it('only a real failure (success false, failed state, failure_message) reads "· Failed" in red and shows the view\'s red box', () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      finalRow({
        title: 'Task Incomplete',
        code_agent: closedCodeAgent('failed', {
          failure_message: 'Tests failed: 3 of 38',
          summary: undefined,
        }),
      }),
    ];
    expectRow(messages, 'failed');
    expectView(messages, 'failed', { failure: 'Tests failed: 3 of 38' });
  });
});

describe('W5b: usage-limit stop (C15)', () => {
  it("older producer (state 'failed' + the parent's retry text): Paused with the limit details, never the retry text", () => {
    const messages = [chipMessage({ provider: 'claude' }), usageLimitRow('claude')];
    expectRow(messages, 'paused');
    const details = usageLimitDetails({ provider: 'claude', resets_at: RESETS_AT });
    const view = expectView(messages, 'paused', { note: details });
    expect(details).toMatch(/^Claude Code usage limit reached · resets /);
    // Never the parent's retry instruction; no Retry (there is no user-callable route).
    expect(screen.queryByText(/spawn_agent|resumes on/)).not.toBeInTheDocument();
    expect(within(view).queryByTestId('code-agent-failure')).not.toBeInTheDocument();
  });

  it("paused producer: the backend's user text verbatim in the view, no Retry", () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      finalRow({
        code_provider: 'claude',
        code_session: codeSession(),
        code_agent: closedCodeAgent('paused', { failure_message: USER_PAUSE_TEXT }),
        failure_kind: 'usage_limit',
        retryable: true,
        session_paused: true,
        usage_limit: { provider: 'claude', resets_at: RESETS_AT },
        retry: { tool: 'spawn_agent', type: 'code', code_session_id: SESSION_ID },
      }),
    ];
    expectRow(messages, 'paused');
    expectView(messages, 'paused', { note: USER_PAUSE_TEXT });
  });

  it('Codex limit: the row reads Paused and the Codex view shows its own limit details', () => {
    const messages = [chipMessage({ provider: 'codex' }), usageLimitRow('codex')];
    const details = usageLimitDetails({ provider: 'codex', resets_at: RESETS_AT });
    expectRow(messages, 'paused');
    const view = expectView(messages, 'paused', { provider: 'codex', note: details });
    expect(view).toHaveAttribute('aria-label', 'Codex: 3-state speed button');
    expect(details).toMatch(/^Codex usage limit reached · resets /);
  });

  it("the activity's own usage_limit row (action_type, state failed) already reads paused", () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      msg({
        toolName: 'spawn_claude_code_agent',
        toolCallId: 'call-task-1',
        toolStatus: 'FINISHED',
        task_id: 'task-1',
        action_type: 'usage_limit',
        code_provider: 'claude',
        code_session: codeSession(),
        code_agent: closedCodeAgent('failed', { failure_message: USAGE_LIMIT_TEXT }),
      }),
    ];
    expectRow(messages, 'paused');
    expectView(messages, 'paused', { note: 'Claude Code usage limit reached' });
  });

  it('failure_kind usage_limit without retryable stays an ordinary failure', () => {
    const row = usageLimitRow('claude');
    const messages = [
      chipMessage({ provider: 'claude' }),
      { ...row, metadata: { ...row.metadata, retryable: false } },
    ];
    expectRow(messages, 'failed');
    expectView(messages, 'failed', { failure: USAGE_LIMIT_TEXT });
  });

  it('an ordinary pause without backend text shows no note', () => {
    const messages = [
      chipMessage({ provider: 'claude' }),
      finalRow({ code_session: codeSession(), code_agent: closedCodeAgent('paused') }),
    ];
    expectRow(messages, 'paused');
    expectView(messages, 'paused');
  });

  it('flag off: stock chip, no paused note', () => {
    renderChip([chipMessage({ provider: 'claude' }), usageLimitRow('claude')], false);
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-agent-paused-note')).not.toBeInTheDocument();
  });
});

describe('W5b: code-session facts and the summary (rows removed by user request)', () => {
  it('a closed task renders no branch → merge target · pushed · PR link, in the root or the view', () => {
    expectSessionFactsGone([
      chipMessage({ provider: 'claude' }),
      finalRow({ code_session: codeSession(), code_agent: closedCodeAgent('paused') }),
    ]);
  });

  it('a merged PR and summary.merged_into render no "· merged" / "merged into" text, in the root or the view', () => {
    const pr = {
      number: 12,
      url: 'https://github.test/rose/pull/12',
      state: 'closed',
      merged: true,
    };
    expectSessionFactsGone([
      chipMessage({ provider: 'claude' }),
      finalRow({
        success: true,
        code_session: codeSession({ pr, merged: true }),
        code_agent: closedCodeAgent('completed', {
          summary: {
            commit: 'c0ffee1234',
            branch: 'rose/task-speed',
            merged_into: 'rose-ui/polish',
            files: [{ path: 'front-end/src/Speed.tsx', added: 12, removed: 3 }],
          },
        }),
      }),
    ]);
  });

  it('a completed summary without merged_into renders no "Committed <sha> on <branch>" row (nor any merge claim)', () => {
    expectSessionFactsGone([
      chipMessage({ provider: 'claude' }),
      finalRow({
        success: true,
        code_session: codeSession({ pushed: false, pr: null }),
        code_agent: closedCodeAgent('completed'),
      }),
    ]);
  });

  it('no session line while the agent is running', () => {
    expectRow([chipMessage({ provider: 'claude' }, { code_session: codeSession() })], 'live');
  });

  it('flag off: no session line', () => {
    renderChip(
      [
        chipMessage({ provider: 'claude' }),
        finalRow({ code_session: codeSession(), code_agent: closedCodeAgent('paused') }),
      ],
      false,
    );
    expect(screen.queryByTestId('code-agent-session')).not.toBeInTheDocument();
  });
});
