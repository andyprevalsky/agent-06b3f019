/**
 * Blackbox: steering code agents (Rose Desktop, UI ledger rows 44, 45, 46; rows
 * 47 and 51 live in code-agent-steering-questions.blackbox.tsx, shared helpers
 * in code-agent-steering.helpers.tsx). Every case runs with the flag on and
 * proves the stock UI is unchanged with the flag off. Backend writes are served
 * by MSW.
 *
 * Redesign (2026-11-06, user-approved): the root keeps ONE plain code-agent row
 * (tool icon · title · "Running|Completed|Failed|Paused" · devbox usage ·
 * elapsed) that folds into the root's "Worked for …" history; a click opens the
 * code-agent view. No provider header, target label, Open app / Maximize,
 * expand chevron, in-chip transcript, steer input or branch/commit rows in the
 * root. What moved lives in the code-agent view (CodeAgentConversationView):
 *   transcript (thinking, narration, compact tool rows) → its "Worked for …" history
 *   direct turns (send, echo, client_message_id reuse)  → its QueryInput (direct channel)
 *   failure text verbatim → its FailureBox · answered pinned questions → user rows
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import ApprovalChip from '@/features/terminal-component-group/components/ApprovalChip';
import { filterMessagesForSubAgent } from '@/features/terminal-component-group/components/useMessageFiltering';
import { derivePendingApproval } from '@/features/terminal/hooks/derivations';
import type { Message } from '@/lib/api';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import {
  API_BASE,
  LIVE_EVENTS,
  ROOT_AGENT_ID,
  chipMessage,
  codexRequester,
  directTurnMessage,
  eventsMessage,
  msg,
  renderChip,
  renderChipWithView,
  renderItems,
} from './code-agent-steering.fixtures';
import {
  expandWork,
  renderView,
  resetSteeringState,
  userRows,
  viewQueryBox,
  viewTree,
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
  resetSteeringState(fetchSession);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('row 44: code agent chip lifecycle', () => {
  it('completed row is one plain line: title · Completed and its duration; no header, target, summary or links in the root or the view', () => {
    renderChip([chipMessage(COMPLETED)]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'completed');
    expect(within(chip).getByTestId('code-agent-title')).toHaveTextContent(
      /^nub tab behind the query box$/,
    );
    expect(within(chip).getByTestId('code-agent-state')).toHaveTextContent(/^· Completed$/);
    expect(within(chip).getByTestId('code-agent-state')).not.toHaveClass('text-red-600');
    expect(within(chip).getByTestId('code-agent-elapsed')).toHaveTextContent(/^4m 12s$/);
    // Removed from the root by the redesign: provider header, target label, summary rows.
    expect(chip.textContent).not.toMatch(
      /Claude Code Completed Successfully|This Mac|Cloud|Committed|merged into|tests 38\/38/,
    );
    expect(within(chip).queryByTestId('code-agent-target')).toBeNull();
    expect(within(chip).queryByTestId('code-agent-summary')).toBeNull();
    expect(within(chip).queryAllByRole('link')).toHaveLength(0);
    expect(within(chip).queryByText(/Open preview|Open app|View diff|Open PR/)).toBeNull();
    expect(chip.querySelector('svg.lucide-maximize2, svg.lucide-chevron-down')).toBeNull();
  });

  it('a click (or Enter) on the row opens its code-agent view; there is no collapse/expand', async () => {
    const open = vi.fn();
    renderChipWithView([chipMessage(COMPLETED)], open);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('role', 'button');
    expect(chip).not.toHaveAttribute('aria-expanded');
    await userEvent.setup().click(chip);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({
      taskId: 'task-1',
      ownerAgentId: ROOT_AGENT_ID,
      provider: 'claude',
      title: 'nub tab behind the query box',
      status: null,
    });
    // Nothing toggled open in the row itself.
    expect(screen.queryByTestId('code-agent-summary')).toBeNull();
    expect(screen.queryByTestId('code-agent-transcript')).toBeNull();
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('running row shows title · Running and a running timer; no "Codex Active" header or pulsing dot', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-20T12:01:08.000Z'));
    renderChip([chipMessage()]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip).toHaveAttribute('data-code-agent-state', 'live');
    expect(within(chip).getByTestId('code-agent-title')).toHaveTextContent(
      /^3-state speed button$/,
    );
    expect(within(chip).getByTestId('code-agent-state')).toHaveTextContent(/^· Running$/);
    expect(within(chip).queryByText('Codex Active')).toBeNull();
    expect(chip.querySelector('.animate-pulse.bg-green-500')).toBeNull();
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

describe('row 45: transcript and direct steering', () => {
  it('the view holds the transcript: thinking and narration as collapsible thoughts and compact tool rows in its work history; the root row has none', async () => {
    const messages = [chipMessage(), eventsMessage(LIVE_EVENTS)];
    const root = renderChip(messages);
    const chip = screen.getByTestId('code-agent-chip');
    expect(within(chip).queryByTestId('code-agent-transcript')).toBeNull();
    expect(within(chip).queryAllByTestId('code-agent-tool-row')).toHaveLength(0);
    expect(chip.textContent).not.toMatch(/Thinking|widen|FastModeToggle/);
    root.unmount();

    const { view } = renderView(messages);
    const entries = expandWork(view);
    expect(entries.map((entry) => entry.textContent)).toEqual([
      'Thought',
      'Thought',
      'Read front-end/src/…/FastModeToggle.tsx',
      'Edit FastModeToggle.tsx +54 −22',
      'Run npx vitest run fast-mode.blackbox.tsx ✓ 3 passed',
    ]);
    const user = userEvent.setup();
    // Mid-turn narration is an ASSISTANT thought row, collapsed until opened.
    expect(entries[1].querySelector('[data-message-role="ASSISTANT"]')).not.toBeNull();
    expect(within(view).queryByText(/widen the existing toggle to three states/)).toBeNull();
    await user.click(within(entries[1]).getByText('Thought'));
    expect(
      await within(view).findByText(
        /I'll widen the existing toggle to three states instead of adding a new control\./,
      ),
    ).toBeInTheDocument();
  });

  it("a thinking row in the view's work history expands to the code agent's thinking text verbatim", async () => {
    const { view } = renderView([chipMessage(), eventsMessage(LIVE_EVENTS)]);
    const [thinking] = expandWork(view);
    expect(thinking.querySelector('[data-tool-name="thought"]')).not.toBeNull();
    expect(within(view).queryByText(/widen it to three states/)).toBeNull();
    await userEvent.setup().click(within(thinking).getByText('Thought'));
    expect(
      await within(view).findByText(
        /FastModeToggle is a boolean today; widen it to three states\./,
      ),
    ).toBeInTheDocument();
  });

  it('no terminal view in the root row or the code-agent view: no tabs, no terminal surface; the view shows its transcript and query box', () => {
    const messages = [chipMessage(), eventsMessage(LIVE_EVENTS)];
    const root = renderChip(messages);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Terminal' })).not.toBeInTheDocument();
    expect(root.container.querySelector('.code-agent-terminal-mount')).toBeNull();
    // The steer input left the root row.
    expect(screen.queryByPlaceholderText(/Message Codex/)).toBeNull();
    root.unmount();

    const { view, container } = renderView(messages);
    expect(screen.queryByRole('tab', { name: 'Terminal' })).not.toBeInTheDocument();
    expect(container.querySelector('.code-agent-terminal-mount')).toBeNull();
    expect(within(view).getAllByTestId('trajectory-work-group')).toHaveLength(1);
    expect(viewQueryBox()).toBeInTheDocument();
  });

  it("the view's query box sends a direct turn to the session and echoes it as one user row", async () => {
    const posted: Array<{ url: string; body: { client_message_id: string } }> = [];
    server.use(
      http.post(`${API_BASE}/claude-code-session/:taskId/turns`, async ({ request }) => {
        posted.push({
          url: request.url,
          body: (await request.json()) as { client_message_id: string },
        });
        return HttpResponse.json({ status: 'delivered', task_id: 'task-1' });
      }),
    );
    const messages = [chipMessage(), eventsMessage(LIVE_EVENTS)];
    const { view, rerender } = renderView(messages);
    const input = viewQueryBox();
    const user = userEvent.setup();
    await user.type(input, 'Keep the 26px button{Enter}');

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].url).toBe(`${API_BASE}/claude-code-session/task-1/turns`);
    expect(posted[0].body).toEqual({
      client_message_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
      text: 'Keep the 26px button',
      tool_call_id: 'call-task-1',
    });
    await waitFor(() => expect(userRows(view)).toEqual(['Keep the 26px button']));
    expect(input).toHaveValue('');

    // The backend persists the delivered turn (user_direct_turn, direct_turn_id =
    // client_message_id as directChatService writes it): still exactly one row.
    const persisted = directTurnMessage();
    (persisted.metadata as Record<string, unknown>).direct_turn_id =
      posted[0].body.client_message_id;
    rerender(viewTree([...messages, persisted]));
    expect(userRows(screen.getByTestId('code-agent-view'))).toEqual(['Keep the 26px button']);
  });

  it('a direct turn the session echoed back (same client_message_id) renders once in the view', () => {
    // Prod shape (Codex, 2026-10-26): the backend's user_direct_turn row and the
    // session's own user record share the turn id; Codex received it once.
    const sessionEcho = {
      id: 'turn:turn-1',
      seq: 117,
      rev: 1,
      type: 'message',
      role: 'user',
      sender: 'user',
      text: 'hurry up',
      ts: '2026-10-20T12:00:30.000Z',
      client_message_id: 'turn-1',
    };
    const { view } = renderView([
      chipMessage(),
      eventsMessage([...LIVE_EVENTS, sessionEcho]),
      directTurnMessage('hurry up'),
    ]);
    expect(userRows(view)).toEqual(['hurry up']);
    expect(within(view).getAllByText('hurry up')).toHaveLength(1);
  });

  it('two separate direct turns with the same text both render in the view', () => {
    const second = directTurnMessage('hurry up');
    (second.metadata as Record<string, unknown>).direct_turn_id = 'turn-2';
    const { view } = renderView([chipMessage(), directTurnMessage('hurry up'), second]);
    expect(userRows(view)).toEqual(['hurry up', 'hurry up']);
  });

  it('a persisted direct turn renders as a user row in the view without a local echo', () => {
    const { view } = renderView([chipMessage(), directTurnMessage('Use the existing Zap icon')]);
    expect(userRows(view)).toEqual(['Use the existing Zap icon']);
    // The old "You → <agent>:" label is gone; the row is the person's own message.
    expect(view.textContent).not.toContain('You → Codex');
  });

  it("the view's query box keeps the text on failure and shows the backend error verbatim; retrying the same text reuses its client_message_id", async () => {
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
    const { view } = renderView([chipMessage()]);
    const input = viewQueryBox();
    const user = userEvent.setup();
    await user.type(input, 'hello{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'code-agent-view-error');
    expect(alert.textContent).toBe('Code agent session is not running');
    expect(input).toHaveValue('hello');
    expect(userRows(view)).toEqual([]);

    fail = false;
    await user.type(input, '{Enter}');
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].client_message_id).toBe(bodies[0].client_message_id);
    await waitFor(() => expect(userRows(view)).toEqual(['hello']));
    expect(input).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('transcript rows are task-scoped and never render in the root trajectory', () => {
    const anchor = chipMessage();
    const events = eventsMessage(LIVE_EVENTS);
    expect(filterMessagesForSubAgent([anchor, events], undefined)).toEqual([anchor]);
  });

  it('flag off: no tabs or steer box on the live chip', () => {
    renderChip([chipMessage(), eventsMessage(LIVE_EVENTS)], false);
    expect(screen.queryByRole('tab', { name: 'Transcript' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Message Codex/)).not.toBeInTheDocument();
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
