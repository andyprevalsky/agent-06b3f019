/**
 * Blackbox (Andy 2026-10-28): the actively-working row
 *  1. shows a disclosure arrow LEFT of the current-activity icon, and no spinner;
 *  2. old standalone Thought cards (the stock pre-working-row UI) NEVER render
 *     while the session comes up: the transcript subscribes as soon as the
 *     session is authenticated, before the async invite check resolves, so Rose
 *     Desktop must already be on at that first render;
 *  3. a wait_for title never reads "Waiting for Waiting for …";
 *  4. a finished browser agent folds into its "Worked for …" group, and its
 *     collapsed result preview shows no raw markdown.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import Terminal from '@/pages/Terminal';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import { TrajectoryWorkGroup } from '@/features/terminal-component-group/components/TrajectoryWorkGroup';
import { groupTrajectoryWork } from '@/features/terminal-component-group/components/trajectoryWorkGroups';
import {
  waitingTitle,
  waitTarget,
} from '@/features/terminal-component-group/components/waitForPhrase';
import { markdownPreview } from '@/features/terminal-component-group/components/browser-agent-chip/resultPreview';
import { buildAgentToolData } from '@/features/terminal-component-group/components/message-bubble/agentToolData';
import { ToolMessageHeader } from '@/features/terminal-component-group/components/message-bubble/ToolMessageHeader';
import { waitAgentKindNeedsTranscript } from '@/features/terminal-component-group/components/waitAgentKinds';
import { WaitlistGate } from '@/features/auth';
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';
import { isRoseDesktopSession } from '@/lib/roseDesktopSession';
import type { Message } from '@/lib/api';
import { msg, WithAgent } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';
import { server } from './msw/server';

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const cookie of document.cookie.split(';')) {
    const key = cookie.trim().split('=')[0];
    if (key.startsWith('rose-theme')) document.cookie = `${key}=; Max-Age=0; Path=/`;
  }
});

const at = (n: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, n)).toISOString();
const goal = msg(
  {},
  { message_id: 'goal', role: 'USER', text: 'Check balances', timestamp: at(0) },
);
const thought = msg(
  {},
  {
    message_id: 'thought-1',
    role: 'ASSISTANT',
    text: 'Looking at the Chase accounts first.',
    timestamp: at(1),
  },
);
const dagThought = msg(
  { toolName: 'thought', toolCallId: 'dag-thought', toolStatus: 'FINISHED', title: 'Thought' },
  { message_id: 'thought-2', text: 'Reasoning about the next step.', timestamp: at(2) },
);
const search = msg(
  { toolName: 'web_search', toolCallId: 'search', toolStatus: 'IN_PROGRESS', title: 'Search' },
  { message_id: 'search', timestamp: at(3) },
);

function transcript(messages: Message[], roseDesktop: boolean) {
  return createElement(
    RoseDesktopContext.Provider,
    { value: roseDesktop },
    createElement(
      WithAgent,
      { messages, selectedAgentId: 'root' },
      createElement(MessageListItems, {
        filteredMessages: messages,
        groupAgentMessages: true,
        // Root transcript: MessageListView compresses work whenever Rose Desktop is on.
        compressWork: roseDesktop,
        workStatus: 'ACTIVE',
        currentAnimatingId: null,
        onAnimationComplete: () => {},
        selectedAgentId: 'root',
        exploreStepMap: new Map(),
        waitForCheckMap: new Map(),
        streamingMetricsBySubAgentId: new Map(),
      }),
    ),
  );
}

/** The terminal's auth projection (useTerminalAgents) at each step of session start-up. */
function authStep(isFullySignedIn: boolean) {
  const authUser = { id: '1f85ff25-6e29-4c1b-8739-f917bd101a30', is_anonymous: false };
  return { isAnonymous: false, authUser, user: isFullySignedIn ? authUser : null };
}

function expectNoStandaloneThought(container: HTMLElement) {
  for (const id of ['thought-1', 'thought-2']) {
    expect(container.querySelector(`[data-message-id="${id}"]`)).toBeNull();
  }
  expect(screen.queryByText('Looking at the Chase accounts first.')).toBeNull();
  expect(screen.queryByText('Reasoning about the next step.')).toBeNull();
}

describe('actively working row: no stale thought-card flash', () => {
  it('never renders standalone Thought cards at any auth/realtime step of session start-up', () => {
    // Session restored + realtime ready (transcript loads), invite check in flight,
    // check resolves, then a reconnect whose invite check fails.
    const steps = [authStep(false), authStep(true), authStep(false)];
    let messages: Message[] = [goal];
    const view = renderWithProviders(transcript(messages, isRoseDesktopSession(steps[0])));
    for (const next of [thought, dagThought, search]) {
      messages = [...messages, next];
      for (const step of steps) {
        view.rerender(transcript(messages, isRoseDesktopSession(step)));
        expectNoStandaloneThought(view.container);
        expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
      }
    }
  });

  it('keeps the thoughts reachable inside the working row history', () => {
    const view = renderWithProviders(transcript([goal, thought, search], true));
    fireEvent.click(within(screen.getByTestId('trajectory-work-group')).getByRole('button'));
    const history = screen.getByTestId('trajectory-work-history');
    expect(history.querySelector('[data-message-id="thought-1"]')).not.toBeNull();
    expect(view.container.querySelectorAll('[data-message-id="thought-1"]')).toHaveLength(1);
  });
});

function runningGroup(messages: Message[]) {
  return [...groupTrajectoryWork(messages, 'ACTIVE').groupsByLeadId.values()][0];
}

describe('actively working row header', () => {
  it.each([
    ['tool batch', [search]],
    ['thought', [thought]],
  ])('%s: arrow sits left of the activity icon and no spinner renders', (_label, rows) => {
    const { container } = renderWithProviders(
      createElement(TrajectoryWorkGroup, { group: runningGroup(rows), renderMessage: () => null }),
    );
    const button = screen.getByRole('button');
    const arrow = within(button).getByTestId('trajectory-disclosure');
    const icon = within(button).getByTestId('trajectory-activity-icon');
    expect(arrow.classList.contains('lucide-chevron-right')).toBe(true);
    expect(arrow.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.lucide-loader-circle')).toBeNull();
    fireEvent.click(button);
    expect(within(button).getByTestId('trajectory-disclosure')).toHaveClass('lucide-chevron-down');
    expect(within(button).getByTestId('trajectory-activity-icon')).toBeInTheDocument();
  });

  it('a live thinking stream keeps the arrow left of its stock activity icon (no animated blob)', () => {
    const live = msg(
      { toolName: 'thought', title: 'Thinking', toolStatus: 'IN_PROGRESS', ephemeral: true },
      { message_id: 'streaming:thinking', timestamp: at(4) },
    );
    renderWithProviders(
      createElement(TrajectoryWorkGroup, {
        group: runningGroup([live]),
        renderMessage: () => null,
      }),
    );
    const arrow = screen.getByTestId('trajectory-disclosure');
    const icon = screen.getByTestId('trajectory-activity-icon');
    expect(icon).toHaveClass('lucide-lightbulb');
    expect(arrow.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('thinking-indicator')).toBeNull();
  });
});

describe('wait_for row label', () => {
  const wait = (title: string) =>
    msg(
      { toolName: 'wait_for', toolCallId: 'w', toolStatus: 'IN_PROGRESS', title },
      { message_id: 'w', timestamp: at(5) },
    );

  it.each([
    ['Waiting for Waiting for Chase balances', 'Waiting for Chase balances'],
    ['Waiting for waiting for Chase balances', 'Waiting for Chase balances'],
    ['Waiting for Chase balances', 'Waiting for Chase balances'],
  ])('%s → %s', (title, expected) => {
    renderWithProviders(
      createElement(TrajectoryWorkGroup, {
        group: runningGroup([wait(title)]),
        renderMessage: () => null,
      }),
    );
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent(expected);
  });

  it.each([
    // The model's description differs from the agent: the row names the agent's task title.
    [{ agents: ['/root/pull_bank_data'] }, 'Waiting for Pull Bank Data'],
    [{ agents: ['/root/a', '/root/b'] }, 'Waiting for A, B'],
    [{ agents: ['/root/x'], targetNames: ['pull_bank_data'] }, 'Waiting for Pull Bank Data'],
    // No resolvable name (agent id / "any"): the stripped description.
    [{ agents: ['3f1c9a2e-agent-id'] }, 'Waiting for Chase balances'],
    [{ agents: 'any' }, 'Waiting for Chase balances'],
  ])('agents wait %j names the waited-on agent', (extra, expected) => {
    const row = msg(
      {
        toolName: 'wait_for',
        toolCallId: 'w',
        toolStatus: 'IN_PROGRESS',
        waitForMode: 'agents',
        title: 'Waiting for Waiting for Chase balances',
        ...extra,
      },
      { message_id: 'w', timestamp: at(5) },
    );
    renderWithProviders(
      createElement(TrajectoryWorkGroup, { group: runningGroup([row]), renderMessage: () => null }),
    );
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent(expected);
  });

  it('the expanded wait card names the same task as the work row', () => {
    const card = (toolStatus: string, text = '') =>
      buildAgentToolData(
        msg(
          {
            toolName: 'wait_for',
            toolStatus,
            waitForMode: 'agents',
            agents: ['/root/x'],
            targetNames: ['pull_bank_data'],
            description: 'pull_bank_data',
          },
          { message_id: `w-${toolStatus}`, text },
        ),
      );
    expect(card('IN_PROGRESS')?.title).toBe('Waiting for Pull Bank Data');
    expect(card('FINISHED', 'Woken by a sub-agent finishing.')?.title).toBe(
      'Waited for Pull Bank Data · woken by a sub-agent finishing',
    );
  });

  const agentWait = (extra: Record<string, unknown>) =>
    msg(
      {
        toolName: 'wait_for',
        toolCallId: 'w',
        toolStatus: 'IN_PROGRESS',
        waitForMode: 'agents',
        title: 'Waiting for find_update_card',
        ...extra,
      },
      { message_id: 'w', timestamp: at(5) },
    );
  const iconKinds = () =>
    screen.getAllByTestId('wait-agent-icon').map((icon) => icon.getAttribute('data-agent-kind'));

  it.each([
    ['code', 'claude', 'Claude Code'],
    ['code:claude', 'claude', 'Claude Code'],
    ['code:codex', 'codex', 'Codex'],
    ['browser', 'browser', null],
    ['explore', 'explore', null],
    ['general_purpose', 'agent', null],
  ])('a wait on a %s agent shows its task title with the %s icon', (type, kind, alt) => {
    const row = agentWait({
      agents: ['/root/find_update_card'],
      targetNames: ['find_update_card'],
      targetTypes: [type],
    });
    renderWithProviders(
      createElement(TrajectoryWorkGroup, { group: runningGroup([row]), renderMessage: () => null }),
    );
    const line = screen.getByTestId('trajectory-activity-line');
    expect(line).toHaveTextContent(/^Waiting for Find Update Card$/);
    expect(within(line).getByTestId('wait-agent-target')).toHaveTextContent('Find Update Card');
    expect(iconKinds()).toEqual([kind]);
    if (alt) expect(within(line).getByAltText(alt)).toBeInTheDocument();
  });

  it("derives each icon from the transcript's spawns when the row has no targetTypes (Codex code agent)", () => {
    const started = (callId: string, type: string, path: string) =>
      msg(
        {
          toolCallId: callId,
          toolName: 'spawn_agent',
          toolStatus: 'FINISHED',
          hidden: true,
          runInBackground: true,
          backgroundPath: path,
          backgroundAgentType: type,
        },
        { message_id: `started-${callId}`, timestamp: at(1) },
      );
    const codexRow = msg(
      {
        toolCallId: 'call_code',
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'IN_PROGRESS',
        action_type: 'claude_code_started',
        code_provider: 'codex',
      },
      { message_id: 'code-start', timestamp: at(2) },
    );
    const transcript = [
      started('call_code', 'code', '/root/find_update_card'),
      codexRow,
      started('call_br', 'browser', '/root/order_lunch'),
    ];
    const row = agentWait({ agents: ['/root/find_update_card', '/root/order_lunch'] });
    renderWithProviders(
      createElement(
        WithAgent,
        { messages: [...transcript, row] },
        createElement(TrajectoryWorkGroup, {
          group: runningGroup([row]),
          renderMessage: () => null,
        }),
      ),
    );
    const line = screen.getByTestId('trajectory-activity-line');
    expect(line).toHaveTextContent(/^Waiting for Find Update Card, Order Lunch$/);
    expect(iconKinds()).toEqual(['codex', 'browser']);
    expect(within(line).getByAltText('Codex')).toBeInTheDocument();
  });

  it('a finished "Wait ended" row as the latest activity keeps its own label', () => {
    const ended = msg(
      {
        toolName: 'wait_for',
        toolCallId: 'w',
        toolStatus: 'FINISHED',
        waitForMode: 'agents',
        title: 'Wait ended',
        agents: ['/root/find_update_card'],
        targetNames: ['find_update_card'],
        targetTypes: ['code:claude'],
        wokenBy: 'agent_notification',
      },
      { message_id: 'w-ended', timestamp: at(6) },
    );
    renderWithProviders(
      createElement(TrajectoryWorkGroup, {
        group: runningGroup([agentWait({ targetNames: ['find_update_card'] }), ended]),
        renderMessage: () => null,
      }),
    );
    const line = screen.getByTestId('trajectory-activity-line');
    expect(line).toHaveTextContent(/^Wait ended$/);
    expect(screen.queryByTestId('wait-agent-targets')).toBeNull();
  });

  it('a null or missing worker type derives the icon from the transcript', () => {
    const transcript = [
      msg(
        {
          toolCallId: 'call_code',
          toolName: 'spawn_agent',
          toolStatus: 'FINISHED',
          hidden: true,
          runInBackground: true,
          backgroundPath: '/root/find_update_card',
          backgroundAgentType: 'code',
        },
        { message_id: 'started-code', timestamp: at(1) },
      ),
      msg(
        { toolCallId: 'call_code', toolName: 'spawn_claude_code_agent', code_provider: 'codex' },
        { message_id: 'code-row', timestamp: at(2) },
      ),
      msg(
        {
          toolCallId: 'call_br',
          toolName: 'spawn_agent',
          toolStatus: 'FINISHED',
          hidden: true,
          runInBackground: true,
          backgroundPath: '/root/order_lunch',
          backgroundAgentType: 'browser',
        },
        { message_id: 'started-br', timestamp: at(3) },
      ),
    ];
    // Unknown first target (null), missing second entry: both come from the transcript.
    const row = agentWait({
      agents: ['/root/find_update_card', '/root/order_lunch'],
      targetNames: ['find_update_card', 'order_lunch'],
      targetTypes: [null],
    });
    renderWithProviders(
      createElement(
        WithAgent,
        { messages: [...transcript, row] },
        createElement(TrajectoryWorkGroup, {
          group: runningGroup([row]),
          renderMessage: () => null,
        }),
      ),
    );
    expect(iconKinds()).toEqual(['codex', 'browser']);
  });

  it('scans the transcript only when a worker type cannot pick the icon alone', () => {
    const target = (type: string | null) => ({ name: 'x', title: 'X', address: null, type });
    for (const type of ['code:claude', 'code:codex', 'browser', 'explore', 'general_purpose'])
      expect(waitAgentKindNeedsTranscript(target(type))).toBe(false);
    for (const type of [null, 'code', 'something_new'])
      expect(waitAgentKindNeedsTranscript(target(type))).toBe(true);
  });

  it('the expanded wait card shows the same task title and agent icon', () => {
    const card = buildAgentToolData(
      agentWait({
        agents: ['/root/find_update_card'],
        targetNames: ['find_update_card'],
        targetTypes: ['explore'],
      }),
    );
    expect(card?.waitAgents).toMatchObject({ prefix: 'Waiting for', suffix: '' });
    renderWithProviders(
      createElement(ToolMessageHeader, {
        data: card!,
        titleText: card!.title,
        isThought: false,
        hasMessage: false,
        isExpandable: false,
        showChevron: false,
        shouldBeExpanded: false,
        onToggle: () => {},
      }),
    );
    expect(screen.getByTestId('wait-agent-targets')).toHaveTextContent(
      /^Waiting for Find Update Card$/,
    );
    expect(iconKinds()).toEqual(['explore']);
  });

  it('normalizes a model-written description to the waited-on target', () => {
    expect(waitTarget('Waiting for Chase balances')).toBe('Chase balances');
    expect(waitTarget('Chase balances')).toBe('Chase balances');
    expect(waitTarget('Waiting for')).toBe('Waiting for');
    expect(waitingTitle('Searching the web')).toBe('Searching the web');
  });
});

describe('finished browser agents fold into the work group', () => {
  const browserDone = (metadata: Record<string, unknown>, extra: Partial<Message> = {}) =>
    msg(
      {
        toolName: 'spawn_browser_agent',
        toolCallId: 'browser-call',
        task_id: 'browser-task',
        toolStatus: 'FINISHED',
        action_type: 'task_complete',
        title: 'Browser Agent',
        ...metadata,
      },
      {
        message_id: 'browser-done',
        text: "**Goal**: Log into the user's authenticated Chase account\n**Status**: ✅ SUCCESS",
        timestamp: at(6),
        ...extra,
      },
    );
  const before = msg(
    { toolName: 'web_search', toolCallId: 's1', toolStatus: 'FINISHED', title: 'Search' },
    { message_id: 's1', timestamp: at(5) },
  );
  const after = msg(
    { toolName: 'read_file', toolCallId: 'r1', toolStatus: 'FINISHED', title: 'Read' },
    { message_id: 'r1', timestamp: at(7) },
  );
  const recording: Message['file_pointer'] = {
    id: 'rec',
    storage_path: 'recordings/rec.mp4',
    original_filename: 'rec.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1,
    created_at: at(6),
  };

  it.each([
    [
      'auth-assistance resume block',
      browserDone({ requestUserAuthentication: { resumeMode: 'x' } }),
    ],
    ['recording file pointer', browserDone({}, { file_pointer: recording })],
    [
      'stopped (session_paused)',
      browserDone({ action_type: 'session_paused', toolStatus: 'ERROR' }),
    ],
    ['plain completion', browserDone({})],
  ])('%s: counted inside the collapsed group, never standalone', (_label, browser) => {
    for (const status of ['COMPLETED', 'PAUSED', 'ACTIVE']) {
      const rows = [goal, before, browser, after];
      const view = renderWithProviders(
        createElement(
          WithAgent,
          { messages: rows, selectedAgentId: 'root' },
          createElement(MessageListItems, {
            filteredMessages: rows,
            compressWork: true,
            workStatus: status,
            currentAnimatingId: null,
            onAnimationComplete: () => {},
            selectedAgentId: 'root',
            exploreStepMap: new Map(),
            waitForCheckMap: new Map(),
            streamingMetricsBySubAgentId: new Map(),
          }),
        ),
      );
      const groups = screen.getAllByTestId('trajectory-work-group');
      expect(groups).toHaveLength(1);
      expect(screen.queryByTestId('browser-agent-chip')).toBeNull();
      if (status !== 'ACTIVE') expect(groups[0]).toHaveTextContent('3 activities');
      view.unmount();
    }
  });

  it('the collapsed browser result preview shows no raw markdown', () => {
    expect(markdownPreview("**Goal**: Log into the user's `Chase` [account](https://x)")).toBe(
      "Goal: Log into the user's Chase account",
    );
    expect(markdownPreview('## Result\n- one')).toBe('Result\n• one');
  });
});

describe('Rose Desktop comes up with the session, not the invite check', () => {
  const USER = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
  function storeSession() {
    const session = {
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: USER, is_anonymous: false },
    };
    localStorage.setItem('rose-session', JSON.stringify(session));
    localStorage.setItem('app-user', JSON.stringify({ id: USER, is_anonymous: false }));
  }
  const inviteCheck = 'http://localhost:3001/api/invite-codes/check';
  const htmlIsDark = () => document.documentElement.classList.contains('dark');

  it.each([false, true])(
    'logged-out terminal uses new chrome (anonymous session: %s)',
    async (anonymous) => {
      if (anonymous) {
        localStorage.setItem(
          'rose-session',
          JSON.stringify({
            access_token: 'anonymous-token',
            refresh_token: 'anonymous-refresh',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            token_type: 'bearer',
            user: { id: 'anonymous-session', is_anonymous: true },
          }),
        );
      }
      renderWithProviders(createElement(Terminal));
      expect(await screen.findByTestId('rose-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('rose-app-icons')).toBeInTheDocument();
      expect(screen.getByTestId('query-toolbar-nub')).toBeInTheDocument();
      expect(screen.queryByText('Safe Writes')).toBeNull();
      expect(screen.getByTestId('query-model-selector')).toHaveTextContent('rose-flash');
      expect(document.documentElement).not.toHaveClass('dark');
      fireEvent.click(screen.getByTestId('rose-app-dark-mode'));
      expect(document.documentElement).toHaveClass('dark');
      expect(localStorage.getItem('rose-theme:guest')).toBe('dark');
    },
  );

  it.each([
    ['pending', () => delay('infinite')],
    ['failed (reconnect)', () => HttpResponse.json({ error: 'down' }, { status: 500 })],
  ])('invite check %s: Rose Desktop chrome and dark theme are already on', async (_l, reply) => {
    server.use(http.get(inviteCheck, reply));
    storeSession();
    localStorage.setItem(`rose-theme:${USER}`, 'dark');
    renderWithProviders(createElement(Terminal));
    expect(await screen.findByTestId('rose-app-icons')).toBeInTheDocument();
    await waitFor(() => expect(htmlIsDark()).toBe(true));
  });

  it('a known waitlisted account keeps the new chrome without bypassing the invite check', async () => {
    let answered = 0;
    server.use(
      http.get(inviteCheck, () => {
        answered += 1;
        return HttpResponse.json({ needsInviteCode: true });
      }),
    );
    storeSession();
    renderWithProviders(
      <>
        <Terminal />
        <WaitlistGate />
      </>,
    );
    await screen.findByText("You're On The Waitlist!");
    expect(answered).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByTestId('rose-app-icons')).toBeInTheDocument());
    expect(screen.getByTestId('rose-app-icons')).toBeInTheDocument();
    expect(
      isRoseDesktopSession({ isAnonymous: false, authUser: { id: USER }, inviteRequired: true }),
    ).toBe(true);
  });
});
