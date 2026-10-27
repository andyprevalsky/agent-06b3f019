/**
 * Blackbox: the desktop code-agent chip on the W5b persistent-session contract
 * (feat/rose-user-ui @ f78bf8aa8; agents/domains/spawn_claude_code_agent
 * handler.py + service.py build_code_agent_metadata):
 *
 *   code_agent.state 'paused'  idle pause, user pause or waiting on the parent:
 *                              resumable, shown as paused, never failed/red.
 *   C15 usage limit            the spawn's final row carries failure_kind
 *                              'usage_limit', retryable, usage_limit{provider},
 *                              retry{tool, type, code_session_id}; the activity's
 *                              own row has action_type 'usage_limit'. Shown as
 *                              "<CLI> Paused" (an older 'failed' state corrected)
 *                              plus one muted line with the backend's text for the
 *                              user: code_agent.failure_message when the producer
 *                              wrote state 'paused', else the usage_limit details
 *                              (never the parent's retry instruction). No Retry
 *                              button: there is no user-callable retry/resume route.
 *   code_session               branch → merge_target, pushed, PR, merged.
 *   summary.merged_into        shown only when present.
 *
 * Flag off keeps the stock chip for the same rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usageLimitDetails } from '@/features/terminal-component-group/hooks/codeAgentContract';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';

import { chipMessage, codeAgent, msg, renderChip, signIn } from './code-agent-steering.fixtures';

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

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
});

describe('W5b: paused code sessions', () => {
  it('an idle-paused session reads Paused with a muted glyph, never failed or red', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({
        session_paused: true,
        code_session: codeSession(),
        code_agent: closedCodeAgent('paused'),
      }),
    ]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'paused');
    expect(within(chip).getByText('Claude Code Paused')).toBeInTheDocument();
    expect(within(chip).queryByText(/Failed/)).not.toBeInTheDocument();
    expect(within(chip).queryByTestId('code-agent-failure')).not.toBeInTheDocument();
    expect(chip.querySelector('svg.text-red-500')).toBeNull();
    expect(chip.querySelector('svg.lucide-circle-pause')).not.toBeNull();
    expect(within(chip).getByTestId('code-agent-elapsed')).toHaveTextContent('3m 05s');
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

  it('fullscreen shows the same paused state, not Failed', async () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({ code_agent: closedCodeAgent('paused') }),
    ]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Maximize Claude Code' }));
    expect(screen.getByText('Claude Code Paused')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code Failed')).not.toBeInTheDocument();
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
    renderChip([
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
    ]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'paused');
    expect(within(chip).queryByTestId('code-agent-failure')).not.toBeInTheDocument();
  });
});

describe('terminal rows: a real success never reads as failed', () => {
  it('the real success row (handler completed_metadata) shows Completed Successfully with its summary', () => {
    renderChip([
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
    ]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'completed');
    expect(within(chip).getByText('Claude Code Completed Successfully')).toBeInTheDocument();
    expect(within(chip).getByTestId('code-agent-summary')).toHaveTextContent(
      'Committed c0ffee1 on rose/task-speed',
    );
    expect(within(chip).getByTestId('code-agent-file')).toHaveTextContent(
      'front-end/src/Speed.tsx',
    );
    expect(within(chip).queryByTestId('code-agent-failure')).not.toBeInTheDocument();
    expect(chip.querySelector('svg.text-red-500')).toBeNull();
  });

  it('an explicit completed snapshot without a success flag (visual fixture) is not re-read as failed', () => {
    renderChip([
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
    ]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'completed');
    expect(within(chip).getByText('Claude Code Completed Successfully')).toBeInTheDocument();
    expect(within(chip).queryByText('Claude Code Failed')).not.toBeInTheDocument();
    expect(within(chip).queryByTestId('code-agent-failure')).not.toBeInTheDocument();
  });

  it('only a real failure (success false, failed state, failure_message) shows the red box', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({
        title: 'Task Incomplete',
        code_agent: closedCodeAgent('failed', {
          failure_message: 'Tests failed: 3 of 38',
          summary: undefined,
        }),
      }),
    ]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'failed');
    expect(within(chip).getByTestId('code-agent-failure')).toHaveTextContent(
      'Tests failed: 3 of 38',
    );
  });
});

describe('W5b: usage-limit stop (C15)', () => {
  const note = () => screen.getByTestId('code-agent-paused-note');

  it("older producer (state 'failed' + the parent's retry text): Paused with the limit details, never the retry text", () => {
    renderChip([chipMessage({ provider: 'claude' }), usageLimitRow('claude')]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'paused');
    expect(within(chip).getByText('Claude Code Paused')).toBeInTheDocument();
    expect(note()).toHaveTextContent(
      usageLimitDetails({ provider: 'claude', resets_at: RESETS_AT }),
    );
    expect(note()).toHaveTextContent(/^Claude Code usage limit reached · resets /);
    expect(note().className).not.toMatch(/red/);
    expect(within(chip).queryByTestId('code-agent-failure')).not.toBeInTheDocument();
    expect(within(chip).queryByText(/spawn_agent/)).not.toBeInTheDocument();
    expect(chip.querySelector('svg.text-red-500')).toBeNull();
    // No user-callable retry route exists, so no Retry action is offered.
    expect(within(chip).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/resumes on/)).not.toBeInTheDocument();
  });

  it("paused producer: the backend's user text verbatim, no Retry", () => {
    renderChip([
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
    ]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'paused');
    expect(within(chip).getByText('Claude Code Paused')).toBeInTheDocument();
    expect(note().textContent).toBe(USER_PAUSE_TEXT);
    expect(within(chip).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('Codex limit: Codex Paused with its own limit details', () => {
    renderChip([chipMessage({ provider: 'codex' }), usageLimitRow('codex')]);
    expect(screen.getByText('Codex Paused')).toBeInTheDocument();
    expect(note()).toHaveTextContent(/^Codex usage limit reached · resets /);
  });

  it("the activity's own usage_limit row (action_type, state failed) already reads paused", () => {
    renderChip([
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
    ]);
    expect(screen.getByText('Claude Code Paused')).toBeInTheDocument();
    expect(note()).toHaveTextContent('Claude Code usage limit reached');
    expect(screen.queryByTestId('code-agent-failure')).not.toBeInTheDocument();
  });

  it('failure_kind usage_limit without retryable stays an ordinary failure', () => {
    const row = usageLimitRow('claude');
    renderChip([
      chipMessage({ provider: 'claude' }),
      { ...row, metadata: { ...row.metadata, retryable: false } },
    ]);
    expect(screen.getByTestId('code-agent-chip')).toHaveAttribute(
      'data-code-agent-state',
      'failed',
    );
    expect(screen.queryByTestId('code-agent-paused-note')).not.toBeInTheDocument();
  });

  it('an ordinary pause without backend text shows no note', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({ code_session: codeSession(), code_agent: closedCodeAgent('paused') }),
    ]);
    expect(screen.getByText('Claude Code Paused')).toBeInTheDocument();
    expect(screen.queryByTestId('code-agent-paused-note')).not.toBeInTheDocument();
  });

  it('flag off: stock chip, no paused note', () => {
    renderChip([chipMessage({ provider: 'claude' }), usageLimitRow('claude')], false);
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-agent-paused-note')).not.toBeInTheDocument();
  });
});

describe('W5b: code-session facts and the summary', () => {
  it('a closed task shows branch → merge target · pushed · PR link from code_session', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({ code_session: codeSession(), code_agent: closedCodeAgent('paused') }),
    ]);
    const line = screen.getByTestId('code-agent-session');
    expect(line).toHaveTextContent('rose/task-speed → rose-ui/polish · pushed · PR #12');
    expect(line).not.toHaveTextContent('merged');
    expect(within(line).getByRole('link', { name: 'PR #12' })).toHaveAttribute(
      'href',
      'https://github.test/rose/pull/12',
    );
  });

  it('merged only once GitHub confirms it; the summary shows merged_into only when present', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({
        success: true,
        code_session: codeSession({
          pr: {
            number: 12,
            url: 'https://github.test/rose/pull/12',
            state: 'closed',
            merged: true,
          },
          merged: true,
        }),
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
    expect(screen.getByTestId('code-agent-session')).toHaveTextContent(
      'rose/task-speed → rose-ui/polish · pushed · PR #12 · merged',
    );
    const summary = screen.getByTestId('code-agent-summary');
    expect(summary).toHaveTextContent('merged into rose-ui/polish');
    expect(within(summary).getByTestId('code-agent-file')).toHaveTextContent(
      '+12−3front-end/src/Speed.tsx',
    );
  });

  it('a completed summary without merged_into never claims a merge', () => {
    renderChip([
      chipMessage({ provider: 'claude' }),
      finalRow({
        success: true,
        code_session: codeSession({ pushed: false, pr: null }),
        code_agent: closedCodeAgent('completed'),
      }),
    ]);
    const summary = screen.getByTestId('code-agent-summary');
    expect(summary).toHaveTextContent('Committed c0ffee1 on rose/task-speed');
    expect(summary).not.toHaveTextContent('merged');
    expect(within(summary).getAllByTestId('code-agent-file')).toHaveLength(1);
    expect(screen.getByTestId('code-agent-session')).toHaveTextContent(
      'rose/task-speed → rose-ui/polish',
    );
    expect(screen.getByTestId('code-agent-session')).not.toHaveTextContent(/pushed|PR|merged/);
  });

  it('no session line while the agent is running', () => {
    renderChip([chipMessage({ provider: 'claude' }, { code_session: codeSession() })]);
    expect(screen.getByTestId('code-agent-chip')).toHaveAttribute('data-code-agent-state', 'live');
    expect(screen.queryByTestId('code-agent-session')).not.toBeInTheDocument();
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
