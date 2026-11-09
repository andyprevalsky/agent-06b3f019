/**
 * Blackbox: steering code agents, the pinned question above the query box (UI
 * ledger row 47) and the execution target / local failures (row 51). Split from
 * code-agent-steering.blackbox.tsx (rows 44-46) to keep each file under the
 * max-lines budget; shared helpers live in code-agent-steering.helpers.tsx.
 * Every case runs with the flag on and proves the stock UI is unchanged with
 * the flag off. Backend writes are served by MSW.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';
import { CodeAgentConversationView } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentConversationView';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { PinnedQuestionMount } from '@/features/terminal-component-group/components/PinnedQuestion';
import { localFailureText } from '@/features/terminal-component-group/hooks/codeAgentContract';
import type { Message } from '@/lib/api';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import {
  API_BASE,
  QUESTION_DISPLAY,
  ROOT_AGENT_ID,
  WithAgent,
  chipMessage,
  msg,
  questionMessage,
  renderChip,
  renderItems,
} from './code-agent-steering.fixtures';
import {
  VIEW_AGENT,
  expandWork,
  renderView,
  resetSteeringState,
  userRows,
} from './code-agent-steering.helpers';

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

beforeEach(() => {
  resetSteeringState(fetchSession);
});

afterEach(() => {
  vi.useRealTimers();
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

  /** The pinned card plus task-1's code-agent view (read only), where answers echo. */
  function renderPinnedWithView(messages: Message[]) {
    renderWithProviders(
      <WithAgent messages={messages}>
        <ClaudeCodeChip taskId="task-1" />
        <PinnedQuestionMount />
        <CodeAgentConversationView codeAgent={VIEW_AGENT} readOnlyMessage="read only" />
      </WithAgent>,
    );
    return screen.getByTestId('code-agent-view');
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

  it("clicking an answer posts it, unpins the card and echoes it as a user row in the code agent's view", async () => {
    const answers = captureAnswers();
    const view = renderPinnedWithView([chipMessage(), questionMessage()]);
    expect(userRows(view)).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: /Only behind the flag/ }));
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
    expect(answers).toEqual([
      {
        url: `${API_BASE}/agents/${ROOT_AGENT_ID}/questions/q-1/answer`,
        body: { answer: 'Only behind the flag' },
      },
    ]);
    await waitFor(() => expect(userRows(view)).toEqual(['Only behind the flag']));
    // The root row carries no transcript of its own.
    expect(screen.queryByTestId('code-agent-transcript')).toBeNull();
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

  it("dismiss sends {dismiss: true} and unpins, with no answer echo in the code agent's view", async () => {
    const answers = captureAnswers();
    const view = renderPinnedWithView([chipMessage(), questionMessage()]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss question' }));
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
    expect(answers.map((a) => a.body)).toEqual([{ dismiss: true }]);
    expect(userRows(view)).toEqual([]);
    expect(view.textContent).not.toContain('You → Codex');
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
  it('the row carries the target as data (local / cloud) and shows no "This Mac · <folder>" / "Cloud" label', () => {
    const local = renderChip([
      chipMessage({ target: 'local', folder: '~/Developer/rose', device_name: 'Andy MBP' }),
    ]);
    const localRow = screen.getByTestId('code-agent-chip');
    expect(localRow).toHaveAttribute('data-code-agent-target', 'local');
    expect(within(localRow).queryByTestId('code-agent-target')).toBeNull();
    expect(localRow.textContent).not.toMatch(/This Mac|~\/Developer\/rose|Andy MBP/);
    local.unmount();
    renderChip([chipMessage({ target: 'cloud' })]);
    const cloudRow = screen.getByTestId('code-agent-chip');
    expect(cloudRow).toHaveAttribute('data-code-agent-target', 'cloud');
    expect(within(cloudRow).queryByTestId('code-agent-target')).toBeNull();
    expect(cloudRow.textContent).not.toMatch(/Cloud/);
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

  /**
   * The root transcript's own row for the spawn call (the ERROR row wins its
   * toolCallId): expanded, it shows the backend's text. Returns that text node.
   */
  function rootFailureText(messages: Message[], text: string): HTMLElement {
    const root = renderWithProviders(
      <WithAgent messages={messages}>
        <MessageList />
      </WithAgent>,
    );
    const history = root.container;
    expandWork(history);
    const row = history.querySelector<HTMLElement>(
      '[data-tool-name="spawn_claude_code_agent"][data-tool-status="ERROR"]',
    );
    expect(row).not.toBeNull();
    fireEvent.click(within(row!).getByText('Code session failed'));
    return within(row!).getByText(text);
  }

  const spawnStarted = () =>
    msg({
      toolName: 'spawn_claude_code_agent',
      toolCallId: 'call-local-1',
      toolStatus: 'IN_PROGRESS',
      code_provider: 'codex',
    });

  it('Mac app closed: the pending row reads "Codex · Failed" in red; the LOCAL_TARGET_UNAVAILABLE message stays verbatim on the root error row', () => {
    const message = oracle(localFailureText('local_disconnected', "Andy's MacBook Pro"));
    const failed = localUnavailableRow(message, "Andy's MacBook Pro");
    const chipRender = renderPendingChip([failed]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'failed');
    expect(chip).toHaveAttribute('data-code-agent-target', 'local');
    expect(within(chip).getByTestId('code-agent-title')).toHaveTextContent(/^Codex$/);
    expect(within(chip).getByTestId('code-agent-state')).toHaveTextContent(/^· Failed$/);
    expect(within(chip).getByTestId('code-agent-state')).toHaveClass('text-red-600');
    // The red failure box moved to the code-agent view; the row carries no text box.
    expect(within(chip).queryByTestId('code-agent-failure')).toBeNull();
    expect(screen.queryByText('Codex Failed')).toBeNull();
    chipRender.unmount();

    expect(rootFailureText([spawnStarted(), failed], message).textContent).toBe(message);
  });

  it('web-initiated agent: the backend text verbatim, never re-worded client-side', () => {
    const message = oracle(localFailureText('local_requires_mac_app', undefined));
    const required = rootFailureText([spawnStarted(), localUnavailableRow(message)], message);
    expect(required.textContent).toBe(message);
    cleanup();
    // Any other backend wording is shown as sent (no hardcoded client strings).
    const custom =
      "Can't run locally: no folder on Andy's Mac is shared with Rose. Share a folder in the Rose Mac app and retry, or run this agent in the cloud.";
    expect(rootFailureText([spawnStarted(), localUnavailableRow(custom)], custom).textContent).toBe(
      custom,
    );
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
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'live');
    expect(chip).toHaveAttribute('data-code-agent-target', 'local');
    // No title in the snapshot: the provider name stands in.
    expect(within(chip).getByTestId('code-agent-title')).toHaveTextContent(/^Codex$/);
    expect(within(chip).getByTestId('code-agent-state')).toHaveTextContent(/^· Running$/);
    expect(within(chip).queryByTestId('code-agent-target')).toBeNull();
    expect(chip.textContent).not.toMatch(/This Mac|Andy MBP/);
  });

  it('no terminal affordance: "Open in Terminal" never renders, even for a live local session in the Mac app', () => {
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
      expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
      expect(openTerminal).not.toHaveBeenCalled();
    } finally {
      delete window.api;
    }
  });

  it("other failures: the row reads · Failed in red and the view's red failure box shows failure_message verbatim", () => {
    const messages = [
      chipMessage({ state: 'failed', failure_message: 'Sandbox crashed (exit 137)' }),
    ];
    const root = renderChip(messages);
    const chip = screen.getByTestId('code-agent-chip');
    expect(within(chip).getByTestId('code-agent-state')).toHaveTextContent(/^· Failed$/);
    expect(within(chip).getByTestId('code-agent-state')).toHaveClass('text-red-600');
    expect(within(chip).queryByTestId('code-agent-failure')).toBeNull();
    root.unmount();

    const { view } = renderView(messages);
    expect(view).toHaveAttribute('data-code-agent-state', 'failed');
    const box = within(view).getByTestId('code-agent-failure');
    expect(box.textContent).toBe('Sandbox crashed (exit 137)');
    expect(box.closest('.border-red-500\\/30')).not.toBeNull();
  });

  it('flag off: no target label', () => {
    renderChip([chipMessage({ target: 'local', folder: '~/Developer/rose' })], false);
    expect(screen.queryByTestId('code-agent-target')).not.toBeInTheDocument();
  });
});
