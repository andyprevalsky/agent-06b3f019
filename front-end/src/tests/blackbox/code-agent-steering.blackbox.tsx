/**
 * Blackbox: steering code agents in the trajectory (Rose Desktop, UI ledger
 * rows 44, 45, 46, 47, 51). Every case runs with the flag on and proves the
 * stock UI is unchanged with the flag off. Backend writes are served by MSW.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';
import ApprovalChip from '@/features/terminal-component-group/components/ApprovalChip';
import { PinnedQuestionMount } from '@/features/terminal-component-group/components/PinnedQuestion';
import { filterMessagesForSubAgent } from '@/features/terminal-component-group/components/useMessageFiltering';
import { localFailureText } from '@/features/terminal-component-group/hooks/codeAgentContract';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import { derivePendingApproval } from '@/features/terminal/hooks/derivations';
import type { Message } from '@/lib/api';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import {
  API_BASE,
  LIVE_EVENTS,
  QUESTION_DISPLAY,
  ROOT_AGENT_ID,
  WithAgent,
  chipMessage,
  codexRequester,
  directTurnMessage,
  eventsMessage,
  msg,
  questionMessage,
  renderChip,
  renderItems,
  signIn,
} from './code-agent-steering.fixtures';

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

const COMPLETED = {
  state: 'completed',
  provider: 'claude',
  target: 'local',
  device_name: "Andy's MacBook Pro",
  folder: '~/Developer/rose',
  title: 'nub tab behind the query box',
  started_at: '2026-10-20T12:00:00.000Z',
  ended_at: '2026-10-20T12:04:12.000Z',
  summary: {
    commit: 'a41c9e2f00d',
    branch: 'rose-ui/polish/nub',
    merged_into: 'rose-ui/polish',
    tests_passed: 38,
    tests_total: 38,
    files: [
      { path: 'front-end/src/…/query-input/ToolbarNub.tsx', added: 86, removed: 31 },
      { path: 'front-end/src/…/QueryInput.tsx', added: 41, removed: 7 },
    ],
    preview_url: 'https://preview.rose.test/nub',
  },
};

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('row 44: code agent chip lifecycle', () => {
  it('completed chip shows check, status, task subtitle, duration and target; summary has only Open preview', () => {
    renderChip([chipMessage(COMPLETED)]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'completed');
    expect(chip.querySelector('svg.text-green-500')).not.toBeNull();
    expect(within(chip).getByText('Claude Code Completed Successfully')).toBeInTheDocument();
    expect(within(chip).getByTestId('code-agent-title')).toHaveTextContent(
      '· nub tab behind the query box',
    );
    expect(within(chip).getByTestId('code-agent-elapsed')).toHaveTextContent('4m 12s');

    const summary = within(chip).getByTestId('code-agent-summary');
    expect(summary).toHaveTextContent(
      'Committed a41c9e2 on rose-ui/polish/nub · merged into rose-ui/polish · tests 38/38 passed',
    );
    const files = within(summary).getAllByTestId('code-agent-file');
    expect(files).toHaveLength(2);
    expect(files[0]).toHaveTextContent('+86−31front-end/src/…/query-input/ToolbarNub.tsx');
    const links = within(summary).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Open preview']);
    expect(links[0]).toHaveAttribute('href', 'https://preview.rose.test/nub');
    expect(within(chip).queryByText(/View diff|Open PR/)).not.toBeInTheDocument();
  });

  it('collapses and re-expands the completed summary from the header', async () => {
    renderChip([chipMessage(COMPLETED)]);
    const user = userEvent.setup();
    await user.click(screen.getByText('Claude Code Completed Successfully'));
    expect(screen.queryByTestId('code-agent-summary')).not.toBeInTheDocument();
    await user.click(screen.getByText('Claude Code Completed Successfully'));
    expect(screen.getByTestId('code-agent-summary')).toBeInTheDocument();
  });

  it('active chip shows the pulsing dot, Active and a running timer', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-20T12:01:08.000Z'));
    renderChip([chipMessage()]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(within(chip).getByText('Codex Active')).toBeInTheDocument();
    expect(chip.querySelector('.animate-pulse.bg-green-500')).not.toBeNull();
    expect(within(chip).getByTestId('code-agent-elapsed')).toHaveTextContent('1m 08s');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(within(chip).getByTestId('code-agent-elapsed')).toHaveTextContent('1m 10s');
  });

  it('a later task_complete message outranks a stale live snapshot', () => {
    renderChip([
      chipMessage(),
      msg(
        {
          toolName: 'spawn_claude_code_agent',
          task_id: 'task-1',
          action_type: 'task_complete',
          toolStatus: 'FINISHED',
          success: true,
        },
        { text: 'done' },
      ),
    ]);
    expect(screen.getByTestId('code-agent-chip')).toHaveAttribute(
      'data-code-agent-state',
      'completed',
    );
  });

  it('flag off keeps the stock chip for the same messages', () => {
    renderChip([chipMessage(COMPLETED)], false);
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByText('Open preview')).not.toBeInTheDocument();
    expect(screen.queryByText('This Mac · ~/Developer/rose')).not.toBeInTheDocument();
  });

  it('flag on without code_agent metadata keeps the stock chip', () => {
    renderChip([
      msg({
        toolName: 'spawn_claude_code_agent',
        task_id: 'task-1',
        action_type: 'task_complete',
        toolStatus: 'FINISHED',
        success: true,
      }),
    ]);
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Code Completed Successfully')).toBeInTheDocument();
  });
});

describe('row 45: transcript, terminal and direct steering', () => {
  it('defaults to Transcript with collapsible thinking, messages and compact tool rows', async () => {
    renderChip([chipMessage(), eventsMessage(LIVE_EVENTS)]);
    const user = userEvent.setup();
    expect(screen.getByRole('tab', { name: 'Transcript' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'false');

    const thinking = screen.getByRole('button', { name: /Thinking · 6s/ });
    expect(thinking).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/widen it to three states/)).not.toBeInTheDocument();
    await user.click(thinking);
    expect(screen.getByText(/widen it to three states/)).toBeInTheDocument();

    expect(screen.getByText(/widen the existing toggle to three states/)).toBeInTheDocument();
    const tools = screen.getAllByTestId('code-agent-tool-row');
    expect(tools.map((t) => t.textContent)).toEqual([
      'Readfront-end/src/…/FastModeToggle.tsx',
      'EditFastModeToggle.tsx+54−22',
      'Runnpx vitest run fast-mode.blackbox.tsx✓ 3 passed',
    ]);
    expect(within(tools[2]).getByText('✓ 3 passed')).toHaveClass('text-green-600');
  });

  it('Terminal tab shows the existing terminal surface and hides the transcript', async () => {
    const { container } = renderChip([chipMessage(), eventsMessage(LIVE_EVENTS)]);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    const terminal = container.querySelector('.code-agent-terminal-mount');
    expect(terminal).not.toBeNull();
    expect(terminal!.closest('.hidden')).toBeNull();
    expect(screen.getByTestId('code-agent-transcript').closest('.hidden')).not.toBeNull();
  });

  it('sends a direct turn to the session and echoes it into the transcript', async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    server.use(
      http.post(`${API_BASE}/claude-code-session/:taskId/turns`, async ({ request }) => {
        posted.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ status: 'delivered', task_id: 'task-1' });
      }),
    );
    const view = renderChip([chipMessage(), eventsMessage(LIVE_EVENTS)]);
    const input = screen.getByPlaceholderText('Message Codex directly…');
    expect(screen.getByText('goes straight to its session')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(input, 'Keep the 26px button{Enter}');

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].url).toBe(`${API_BASE}/claude-code-session/task-1/turns`);
    expect(posted[0].body).toEqual({
      client_message_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
      text: 'Keep the 26px button',
      tool_call_id: 'call-task-1',
    });
    expect(await screen.findByText('Keep the 26px button')).toBeInTheDocument();
    expect(screen.getByText('You → Codex:')).toBeInTheDocument();
    expect(input).toHaveValue('');

    // The backend persists the delivered turn (user_direct_turn): still exactly one row.
    view.rerender(
      <WithAgent messages={[chipMessage(), eventsMessage(LIVE_EVENTS), directTurnMessage()]}>
        <ClaudeCodeChip taskId="task-1" />
      </WithAgent>,
    );
    expect(screen.getAllByText('Keep the 26px button')).toHaveLength(1);
    expect(screen.getAllByText('You → Codex:')).toHaveLength(1);
  });

  it('a persisted direct turn renders as "You → <agent>" without a local echo', () => {
    renderChip([chipMessage(), directTurnMessage('Use the existing Zap icon')]);
    expect(screen.getByTestId('code-agent-transcript')).toHaveTextContent(
      'You → Codex: Use the existing Zap icon',
    );
  });

  it('keeps the text on failure; retrying the same text reuses its client_message_id', async () => {
    const bodies: Array<{ client_message_id: string }> = [];
    let fail = true;
    server.use(
      http.post(`${API_BASE}/claude-code-session/:taskId/turns`, async ({ request }) => {
        bodies.push((await request.json()) as { client_message_id: string });
        return fail
          ? HttpResponse.json({ error: 'Code agent session is not running' }, { status: 409 })
          : HttpResponse.json({ status: 'duplicate', task_id: 'task-1' });
      }),
    );
    renderChip([chipMessage()]);
    const input = screen.getByPlaceholderText('Message Codex directly…');
    const user = userEvent.setup();
    await user.type(input, 'hello{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't reach Codex: Code agent session is not running",
    );
    expect(input).toHaveValue('hello');
    expect(screen.queryByText('You → Codex:')).not.toBeInTheDocument();

    fail = false;
    await user.type(input, '{Enter}');
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].client_message_id).toBe(bodies[0].client_message_id);
    expect(await screen.findByText('You → Codex:')).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('transcript rows are task-scoped and never render in the root trajectory', () => {
    const anchor = chipMessage();
    const events = eventsMessage(LIVE_EVENTS);
    expect(filterMessagesForSubAgent([anchor, events], undefined)).toEqual([anchor]);
  });

  it('flag off: no tabs or steer box on the live chip', () => {
    renderChip([chipMessage(), eventsMessage(LIVE_EVENTS)], false);
    expect(screen.queryByRole('tab', { name: 'Transcript' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Message Codex directly…')).not.toBeInTheDocument();
  });
});

describe('row 46: scorecards and approvals attributed to the code agent', () => {
  // A scorecard is a user-published inline view: the backend pins its versionId.
  const scorecardMessage = (inlineView: Record<string, unknown>) =>
    msg(
      {
        toolCallId: 'agent-tools:atq_scorecard',
        toolName: 'send_message_to_user',
        toolStatus: 'FINISHED',
        isUserAttentionMessage: true,
        attentionMessage: 'Speed button scorecard',
        sendMessageToUser: { isQuestion: false, attentionKind: 'info', isWaitingForUser: false },
        requestingAgent: codexRequester(),
        subAgentId: 'task-1',
        task_id: 'task-1',
        inlineView,
      },
      { text: 'Speed button scorecard' },
    );
  const SCORECARD = { view: 'scorecard', versionId: 'v3', props: { title: 'Speed button' } };

  it('renders the published scorecard view attributed "Codex · via send_message_to_user"', () => {
    renderItems([scorecardMessage(SCORECARD)]);
    expect(screen.getByTestId('code-agent-attribution')).toHaveTextContent(
      'Codex · via send_message_to_user',
    );
    expect(screen.getByTestId('user-ui-inline-view')).toHaveAttribute('data-inline-version', 'v3');
  });

  it('flag off: no attribution', () => {
    renderItems([scorecardMessage(SCORECARD)], { roseDesktop: false });
    expect(screen.queryByTestId('code-agent-attribution')).not.toBeInTheDocument();
    expect(screen.getByText('Speed button scorecard')).toBeInTheDocument();
  });

  const approvalMessages: Message[] = [
    msg(
      {
        toolName: 'request_user_approval',
        toolCallId: 'agent-tools:attn-1',
        toolStatus: 'IN_PROGRESS',
        title: '🔐 Codex requests approval',
        isUserAttentionMessage: true,
        requestUserApproval: {
          toolApproval: true,
          attentionRequestId: 'attn-1',
          requestingAgent: codexRequester(),
        },
        requestingAgent: codexRequester(),
      },
      { text: 'Merge rose-ui/polish/speed into rose-ui/polish?' },
    ),
  ];

  it('the existing ApprovalChip is labelled with the requesting agent icon and name', () => {
    const pending = derivePendingApproval(approvalMessages);
    renderWithProviders(<ApprovalChip pendingApproval={pending} />);
    expect(screen.getByText('Approval Required')).toBeInTheDocument();
    const who = screen.getByTestId('approval-requester');
    expect(who).toHaveTextContent('Codex');
    expect(within(who).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
  });

  it('flag off: the ApprovalChip carries no requester label', () => {
    const pending = derivePendingApproval(approvalMessages);
    renderWithProviders(<ApprovalChip pendingApproval={pending} />, { roseDesktop: false });
    expect(screen.getByText('Approval Required')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-requester')).not.toBeInTheDocument();
  });
});

describe('row 47: pinned question above the query box', () => {
  function renderPinned(messages: Message[], roseDesktop = true) {
    return renderWithProviders(
      <WithAgent messages={messages}>
        <ClaudeCodeChip taskId="task-1" />
        <PinnedQuestionMount />
        <textarea aria-label="Query box" />
      </WithAgent>,
      { roseDesktop },
    );
  }

  function captureAnswers() {
    const answers: Array<{ url: string; body: unknown }> = [];
    server.use(
      http.post(`${API_BASE}/agents/:agentId/questions/:questionId/answer`, async ({ request }) => {
        answers.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ ok: true });
      }),
    );
    return answers;
  }

  it('renders "<agent> asks", the question, vertical numbered answers and a numbered Other input', () => {
    renderPinned([chipMessage(), questionMessage()]);
    const card = screen.getByTestId('pinned-question');
    expect(within(card).getByText('Codex asks')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Dismiss question' })).toBeInTheDocument();
    expect(within(card).getByText(QUESTION_DISPLAY.question)).toBeInTheDocument();
    const items = within(within(card).getByRole('list', { name: 'Answers' })).getAllByRole(
      'listitem',
    );
    expect(items.map((li) => li.textContent)).toEqual([
      "1Only behind the flagRecommendedOnly your account gets Ultrafast by default; everyone else keeps today's speed.",
      '2EveryoneAll accounts default to Ultrafast. Higher provider cost.',
      '3Signed-in users onlyVisitors stay on Normal; any signed-in account gets Ultrafast.',
      '4',
    ]);
    expect(within(items[3]).getByPlaceholderText('Other…')).toBeInTheDocument();
  });

  it('is not rendered inline in the trajectory', () => {
    const question = questionMessage();
    const { container } = renderItems([question]);
    expect(container.querySelector(`[data-message-id="${question.message_id}"]`)).toBeNull();
  });

  it('clicking an answer posts it, unpins the card and echoes it into the agent transcript', async () => {
    const answers = captureAnswers();
    renderPinned([chipMessage(), questionMessage()]);
    await userEvent.setup().click(screen.getByRole('button', { name: /Only behind the flag/ }));
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
    expect(answers).toEqual([
      {
        url: `${API_BASE}/agents/${ROOT_AGENT_ID}/questions/q-1/answer`,
        body: { answer: 'Only behind the flag' },
      },
    ]);
    const transcript = screen.getByTestId('code-agent-transcript');
    expect(transcript).toHaveTextContent('You → Codex: Only behind the flag');
  });

  it('pressing a number answers; the Other number focuses Other and Enter sends free text', async () => {
    const answers = captureAnswers();
    const view = renderPinned([chipMessage(), questionMessage()]);
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0].body).toEqual({ answer: 'Everyone' });
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());

    view.rerender(
      <WithAgent messages={[chipMessage(), questionMessage({ question_id: 'q-2' })]}>
        <ClaudeCodeChip taskId="task-1" />
        <PinnedQuestionMount />
      </WithAgent>,
    );
    fireEvent.keyDown(window, { key: '4' });
    const other = screen.getByPlaceholderText('Other…');
    expect(other).toHaveFocus();
    await userEvent.setup().type(other, 'Only for admins{Enter}');
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(answers[1]).toEqual({
      url: `${API_BASE}/agents/${ROOT_AGENT_ID}/questions/q-2/answer`,
      body: { answer: 'Only for admins' },
    });
  });

  it('number keys typed into the query box do not answer', async () => {
    const answers = captureAnswers();
    renderPinned([chipMessage(), questionMessage()]);
    const box = screen.getByRole('textbox', { name: 'Query box' });
    await userEvent.setup().type(box, '1');
    expect(box).toHaveValue('1');
    expect(answers).toHaveLength(0);
    expect(screen.getByTestId('pinned-question')).toBeInTheDocument();
  });

  it('dismiss sends {dismiss: true} (no answer echo) and unpins', async () => {
    const answers = captureAnswers();
    renderPinned([chipMessage(), questionMessage()]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss question' }));
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
    expect(answers.map((a) => a.body)).toEqual([{ dismiss: true }]);
    expect(screen.getByTestId('code-agent-transcript')).not.toHaveTextContent('You → Codex');
  });

  it('keeps the question pinned and shows the error when the answer fails', async () => {
    server.use(
      http.post(`${API_BASE}/agents/:agentId/questions/:questionId/answer`, () =>
        HttpResponse.json({ error: 'Question expired' }, { status: 410 }),
      ),
    );
    renderPinned([chipMessage(), questionMessage()]);
    await userEvent.setup().click(screen.getByRole('button', { name: /Everyone/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Question expired');
    expect(screen.getByTestId('pinned-question')).toBeInTheDocument();
  });

  it('a durably answered question (row FINISHED) is not pinned', () => {
    renderPinned([chipMessage(), questionMessage({}, { toolStatus: 'FINISHED' })]);
    expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument();
  });

  it('flag off: nothing is pinned and the message keeps its stock inline rendering', () => {
    renderPinned([chipMessage(), questionMessage()], false);
    expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument();
    const question = questionMessage();
    const { container } = renderItems([question], { roseDesktop: false });
    expect(container.querySelector(`[data-message-id="${question.message_id}"]`)).not.toBeNull();
  });
});

describe('row 51: execution target and local failures', () => {
  it('header shows "This Mac · <folder>" for local and "Cloud" for cloud', () => {
    const local = renderChip([
      chipMessage({ target: 'local', folder: '~/Developer/rose', device_name: 'Andy MBP' }),
    ]);
    expect(screen.getByTestId('code-agent-target')).toHaveTextContent(
      'This Mac · ~/Developer/rose',
    );
    local.unmount();
    renderChip([chipMessage({ target: 'cloud' })]);
    expect(screen.getByTestId('code-agent-target')).toHaveTextContent(/^Cloud$/);
  });

  /** The spawn tool's ERROR row for an unavailable local target (agents handler, L-LOCAL). */
  function localUnavailableRow(text: string, deviceName?: string) {
    return msg(
      {
        toolName: 'spawn_claude_code_agent',
        toolCallId: 'call-local-1',
        toolStatus: 'ERROR',
        title: 'Code session failed',
        code_provider: 'codex',
        error_code: 'LOCAL_TARGET_UNAVAILABLE',
        code_agent: { target: 'local', ...(deviceName ? { device_name: deviceName } : {}) },
      },
      { text },
    );
  }

  function renderPendingChip(messages: Message[], roseDesktop = true) {
    return renderWithProviders(
      <WithAgent messages={messages}>
        <ClaudeCodeChip taskId="pending" toolCallId="call-local-1" codeProvider="codex" />
      </WithAgent>,
      { roseDesktop },
    );
  }

  const oracle = (text: { lead: string; rest: string }) => `${text.lead} ${text.rest}`;

  it('Mac app closed: the LOCAL_TARGET_UNAVAILABLE message verbatim in the red failure box', () => {
    const message = oracle(localFailureText('local_disconnected', "Andy's MacBook Pro"));
    renderPendingChip([localUnavailableRow(message, "Andy's MacBook Pro")]);
    const box = screen.getByTestId('code-agent-failure');
    expect(box.textContent).toBe(message);
    expect(box.closest('.border-red-500\\/30')).not.toBeNull();
    expect(screen.getByText('Codex Failed')).toBeInTheDocument();
    expect(screen.getByTestId('code-agent-target')).toHaveAttribute('title', "Andy's MacBook Pro");
  });

  it('web-initiated agent: the backend text verbatim, never re-worded client-side', () => {
    const message = oracle(localFailureText('local_requires_mac_app', undefined));
    renderPendingChip([localUnavailableRow(message)]);
    expect(screen.getByTestId('code-agent-failure').textContent).toBe(message);
    // Any other backend wording is shown as sent (no hardcoded client strings).
    const custom =
      "Can't run locally: no folder on Andy's Mac is shared with Rose. Share a folder in the Rose Mac app and retry, or run this agent in the cloud.";
    renderPendingChip([localUnavailableRow(custom)]);
    expect(screen.getAllByTestId('code-agent-failure')[1].textContent).toBe(custom);
  });

  it('real partial snapshot ({target, device_name, folder} + row task_id/provider) drives the desktop chip', () => {
    const started = msg({
      toolName: 'spawn_claude_code_agent',
      toolCallId: 'call-task-1',
      task_id: 'task-1',
      action_type: 'claude_code_started',
      toolStatus: 'IN_PROGRESS',
      code_provider: 'codex',
      code_agent: { target: 'local', device_name: 'Andy MBP', folder: '~/Developer/rose' },
    });
    renderChip([started]);
    expect(screen.getByTestId('code-agent-chip')).toHaveAttribute('data-code-agent-state', 'live');
    expect(screen.getByTestId('code-agent-target')).toHaveTextContent(
      'This Mac · ~/Developer/rose',
    );
    expect(screen.getByTestId('code-agent-target')).toHaveAttribute('title', 'Andy MBP');
  });

  it('Mac app: "Open in Terminal" on a live local session calls localCode.openTerminal(taskId); hidden on web and cloud', async () => {
    const openTerminal = vi.fn().mockResolvedValue({ success: true });
    const live = (target: 'local' | 'cloud') =>
      msg({
        toolName: 'spawn_claude_code_agent',
        toolCallId: 'call-task-1',
        task_id: 'task-1',
        action_type: 'claude_code_started',
        toolStatus: 'IN_PROGRESS',
        code_provider: 'claude',
        code_agent: { target, folder: '~/Developer/rose' },
      });
    const web = renderChip([live('local')]);
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
    web.unmount();

    window.api = { isElectron: true, localCode: { openTerminal } };
    try {
      const cloud = renderChip([live('cloud')]);
      expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
      cloud.unmount();
      renderChip([live('local')]);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Open in Terminal' }));
      expect(openTerminal).toHaveBeenCalledWith('task-1');
    } finally {
      delete window.api;
    }
  });

  it('other failures show failure_message verbatim', () => {
    renderChip([chipMessage({ state: 'failed', failure_message: 'Sandbox crashed (exit 137)' })]);
    expect(screen.getByTestId('code-agent-failure')).toHaveTextContent(
      'Sandbox crashed (exit 137)',
    );
  });

  it('flag off: no target label', () => {
    renderChip([chipMessage({ target: 'local', folder: '~/Developer/rose' })], false);
    expect(screen.queryByTestId('code-agent-target')).not.toBeInTheDocument();
  });
});
