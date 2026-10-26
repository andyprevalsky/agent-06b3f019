/**
 * Blackbox: agent-to-agent rows and the code-agent wire adapter (Rose Desktop,
 * UI ledger rows 12 + 47b, contract from backend agentGraphSendService). Flag
 * on renders "Codex → Rose" rows in the code agent's transcript and the
 * trajectory (never user bubbles); flag off keeps the stock rendering.
 * Malformed metadata always falls back to the stock UI.
 */
import { createElement } from 'react';
import { isRoutineAgentRouting } from '@/features/terminal-component-group/components/code-agent-view/routineAgentRouting';
import { CodeSessionMessages } from '@/features/terminal-component-group/components/code-agent-view/CodeSessionMessages';
import { renderWithProviders } from './test-wrapper';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { PinnedQuestionMount } from '@/features/terminal-component-group/components/PinnedQuestion';
import { filterMessagesForSubAgent } from '@/features/terminal-component-group/components/useMessageFiltering';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import {
  parseAgentToAgentMessage,
  parseCodeAgentMeta,
  parsePinnedQuestion,
} from '@/features/terminal-component-group/hooks/codeAgentContract';
import { collectCodeAgentEvents } from '@/features/terminal-component-group/hooks/codeSessionTranscript';

import {
  msg,
  WithAgent,
  LIVE_EVENTS,
  QUESTION_DISPLAY,
  a2aInboundUserMessage,
  a2aTimelineMessage,
  chipMessage,
  codeAgent,
  eventsMessage,
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

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
});

describe('agent-to-agent rows (L-A2A contract, rows 12 + 47b)', () => {
  const SENT = () => a2aTimelineMessage('sent', 'Tests pass; ready to merge.', 'm-sent');
  const RECEIVED = () => a2aTimelineMessage('received', 'Merge it after the scorecard.', 'm-recv');

  it('code-agent timeline rows render in its transcript as "Codex → Rose" / "Rose → Codex"', () => {
    renderChip([chipMessage(), eventsMessage(LIVE_EVENTS), SENT(), RECEIVED()]);
    const transcript = screen.getByTestId('code-agent-transcript');
    const rows = within(transcript).getAllByTestId('a2a-row');
    expect(rows.map((r) => [r.getAttribute('data-a2a-direction'), r.textContent])).toEqual([
      ['sent', 'Codex → RoseTests pass; ready to merge.'],
      ['received', 'Rose → CodexMerge it after the scorecard.'],
    ]);
    for (const row of rows) {
      expect(within(row).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    }
    // The chip stays the one desktop chip; timeline rows never become a second chip.
    expect(screen.getAllByTestId('code-agent-chip')).toHaveLength(1);
  });

  it('native code-session a2a rows fold into the Worked-for slot as "Codex → Rose" / "Rose → Codex"', () => {
    const messages = [chipMessage(), eventsMessage(LIVE_EVENTS), SENT(), RECEIVED()];
    renderWithProviders(
      createElement(
        WithAgent,
        { messages },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'live', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      ),
    );
    const transcript = screen.getByTestId('code-agent-transcript');
    expect(within(transcript).queryByTestId('agent-exchange-group')).toBeNull();
    const slot = within(transcript).getByTestId('code-work-slot');
    fireEvent.click(within(slot).getByRole('button', { name: /Working/ }));
    const rows = within(slot).getAllByTestId('a2a-row');
    expect(rows.map((r) => [r.getAttribute('data-a2a-direction'), r.textContent])).toEqual([
      ['sent', 'Codex → RoseTests pass; ready to merge.'],
      ['received', 'Rose → CodexMerge it after the scorecard.'],
    ]);
    for (const row of rows) {
      expect(within(row).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    }
    // The chip stays the one desktop chip; timeline rows never become a second chip.
    expect(within(transcript).getAllByTestId('code-work-slot')).toHaveLength(1);
  });

  it('folds hundreds of canonical mirrors into their native work slots: one row each, 20 a page', () => {
    const records = [
      { id: 'start1', type: 'turn', event: 'started', turn_id: 'one', ts: 1000 },
      {
        id: 'end1',
        type: 'turn',
        event: 'ended',
        turn_id: 'one',
        ts: 2000,
        turn_outcome: 'completed',
      },
      { id: 'start2', type: 'turn', event: 'started', turn_id: 'two', ts: 3000 },
      {
        id: 'end2',
        type: 'turn',
        event: 'ended',
        turn_id: 'two',
        ts: 4000,
        turn_outcome: 'completed',
      },
    ];
    const rows = Array.from({ length: 120 }, (_, i) => {
      const row = a2aTimelineMessage('sent', `Native private ${i}`, `canonical-${i}`);
      row.timestamp = new Date(i < 60 ? 1500 : 3500).toISOString();
      if (i % 2 === 0) {
        const a2a = row.metadata!.a2a as Record<string, unknown>;
        a2a.to = { id: 'other-code', kind: 'code', label: 'Other code' };
      }
      return [row, { ...row, message_id: `mirror-${i}` }];
    }).flat();
    const messages = [eventsMessage(records), ...rows];
    const native = (records: typeof messages) =>
      createElement(
        WithAgent,
        { messages: records },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'completed', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      );
    const view = renderWithProviders(native(messages));
    expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
    const slots = screen.getAllByTestId('code-work-slot');
    expect(slots).toHaveLength(2);
    expect(screen.queryByTestId('a2a-row')).toBeNull();
    const [first, second] = slots;
    fireEvent.click(within(first).getByRole('button', { name: /Worked/ }));
    // 120 mirrored rows per turn → 60 exchanges, 20 a page.
    expect(within(first).getAllByTestId('a2a-row')).toHaveLength(20);
    expect(within(first).getByText('1 / 3')).toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button', { name: 'Next activities' }));
    expect(within(first).getByText('Native private 20')).toBeInTheDocument();
    expect(within(first).queryByText('Native private 0')).toBeNull();
    fireEvent.click(within(second).getByRole('button', { name: /Worked/ }));
    expect(within(second).getByText('Native private 60')).toBeInTheDocument();
    expect(within(second).getByText('1 / 3')).toBeInTheDocument();
    view.rerender(native([{ ...rows[0], message_id: 'replayed-lead' }, ...messages]));
    expect(screen.getAllByTestId('code-work-slot')[0]).toBe(first);
    expect(within(first).getByText('Native private 20')).toBeVisible();
    expect(within(first).getByText('2 / 3')).toBeInTheDocument();
  });

  it('keeps human turns, user-facing questions and final answers in the native transcript', () => {
    const one = SENT();
    one.timestamp = new Date(400).toISOString();
    const two = RECEIVED();
    two.timestamp = new Date(1000).toISOString();
    const question = msg(
      {
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        requestingAgent: { kind: 'code_agent', task_id: 'task-1', provider: 'codex' },
      },
      { text: 'Visible question', timestamp: new Date(500).toISOString() },
    );
    const messages = [
      eventsMessage([
        {
          id: 'human1',
          type: 'message',
          role: 'user',
          sender: 'user',
          text: 'First human steer',
          ts: 100,
        },
        { id: 'start1', type: 'turn', event: 'started', turn_id: 'one', ts: 200 },
        { id: 'answer', type: 'message', text: 'Visible final answer', ts: 600, turn_id: 'one' },
        {
          id: 'end1',
          type: 'turn',
          event: 'ended',
          turn_id: 'one',
          ts: 700,
          turn_outcome: 'completed',
        },
        {
          id: 'human2',
          type: 'message',
          role: 'user',
          sender: 'user',
          text: 'Second human steer',
          ts: 800,
        },
        { id: 'start2', type: 'turn', event: 'started', turn_id: 'two', ts: 900 },
        {
          id: 'end2',
          type: 'turn',
          event: 'ended',
          turn_id: 'two',
          ts: 1100,
          turn_outcome: 'completed',
        },
      ]),
      one,
      two,
      question,
    ];
    renderWithProviders(
      createElement(
        WithAgent,
        { messages },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'completed', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      ),
    );
    expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
    const [turnOne, turnTwo] = screen.getAllByTestId('code-work-slot');
    fireEvent.click(within(turnOne).getByRole('button', { name: /Worked/ }));
    fireEvent.click(within(turnTwo).getByRole('button', { name: /Worked/ }));
    expect(within(turnOne).getByText('Tests pass; ready to merge.')).toBeVisible();
    expect(within(turnTwo).getByText('Merge it after the scorecard.')).toBeVisible();
    for (const text of [
      'First human steer',
      'Second human steer',
      'Visible question',
      'Visible final answer',
    ]) {
      expect(screen.getByText(text)).toBeVisible();
    }
    expect(screen.getAllByTestId('code-work-slot')).toHaveLength(2);
  });

  it('the first native Rose instruction is the goal prompt, outside the exchange group', () => {
    const messages = [
      eventsMessage([
        {
          id: 'instruction',
          type: 'message',
          role: 'user',
          sender: 'agent',
          client_message_id: 'native-delivery',
          text: 'Private native instruction',
          ts: 1000,
        },
      ]),
      RECEIVED(),
    ];
    renderWithProviders(
      createElement(
        WithAgent,
        { messages },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'live', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      ),
    );
    // The session's first native Rose instruction is its goal: the user prompt
    // (Andy 2026-10-26), never an "Agents coordinating" exchange.
    const goal = screen.getByText('Private native instruction');
    expect(goal.closest('[data-message-role="USER"]')).not.toBeNull();
    expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
    const slot = screen.getByTestId('code-work-slot');
    expect(slot).toHaveTextContent('Merge it after the scorecard.');
  });

  it('a real rose-agents send session: routing tool, canonical rows and mirror fold into the turn', () => {
    // agentGraphSendService shape: Codex runs `rose-agents send parent …`; the backend
    // writes the canonical agent_message row (plus a replayed mirror with the same
    // a2a.message_id), then Rose's reply arrives as a received row.
    const sent = a2aTimelineMessage('sent', 'Chart pushed to main.', 'a2a-1');
    sent.timestamp = new Date(1600).toISOString();
    const mirror = { ...sent, message_id: 'a2a-1-mirror' };
    const reply = a2aTimelineMessage('received', 'Thanks, close the session.', 'a2a-2');
    reply.timestamp = new Date(1700).toISOString();
    const messages = [
      eventsMessage([
        {
          id: 'goal',
          seq: 0,
          type: 'message',
          role: 'user',
          sender: 'agent',
          text: 'Chart BTC',
          ts: 900,
        },
        { id: 'start', seq: 1, type: 'turn', event: 'started', turn_id: 'one', ts: 1000 },
        {
          id: 'send',
          seq: 2,
          type: 'tool',
          turn_id: 'one',
          ts: 1500,
          tool: {
            name: 'Run',
            target: 'rose-agents send parent "Chart pushed to main."',
            activity_kind: 'exec',
            result: { status: 'ok', exit_code: 0 },
          },
        },
        {
          id: 'end',
          seq: 3,
          type: 'turn',
          event: 'ended',
          turn_id: 'one',
          ts: 2000,
          turn_outcome: 'completed',
        },
      ]),
      sent,
      mirror,
      reply,
    ];
    renderWithProviders(
      createElement(
        WithAgent,
        { messages },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'completed', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      ),
    );
    const transcript = screen.getByTestId('code-agent-transcript');
    expect(within(transcript).queryByTestId('agent-exchange-group')).toBeNull();
    expect(within(transcript).queryByText(/Agents coordinating/)).toBeNull();
    expect(
      within(transcript).getByText('Chart BTC').closest('[data-message-role="USER"]'),
    ).not.toBeNull();
    const slot = within(transcript).getByTestId('code-work-slot');
    expect(within(transcript).queryByTestId('a2a-row')).toBeNull();
    fireEvent.click(within(slot).getByRole('button', { name: /Worked/ }));
    const rows = within(slot).getAllByTestId('a2a-row');
    expect(rows.map((r) => [r.getAttribute('data-a2a-direction'), r.textContent])).toEqual([
      ['sent', 'Codex → RoseChart pushed to main.'],
      ['received', 'Rose → CodexThanks, close the session.'],
    ]);
  });

  it('keeps successful native send payloads behind details and leaves errors visible', () => {
    const messages = [
      eventsMessage([
        { id: 'start', type: 'turn', event: 'started', turn_id: 'one', ts: 1000 },
        {
          id: 'send',
          type: 'tool',
          turn_id: 'one',
          ts: 1500,
          tool: {
            name: 'Run',
            target: 'rose-agents send parent "private payload"',
            activity_kind: 'exec',
            result: { status: 'running' },
          },
        },
      ]),
    ];
    const view = renderWithProviders(
      createElement(
        WithAgent,
        { messages },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'live', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      ),
    );
    expect(screen.queryByText(/private payload/)).toBeNull();
    const routing = screen.getByTestId('code-routing-activity');
    fireEvent.click(within(routing).getByRole('button'));
    expect(within(routing).getByText(/private payload/)).toBeVisible();
    view.unmount();
    const failed = [
      eventsMessage([
        {
          id: 'failure',
          type: 'tool',
          ts: 2000,
          tool: {
            name: 'Run',
            target: 'rose-agents send parent "failed payload"',
            activity_kind: 'exec',
            result: { status: 'error', output: 'Permission denied' },
          },
        },
      ]),
    ];
    renderWithProviders(
      createElement(
        WithAgent,
        { messages: failed },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'live', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      ),
    );
    expect(screen.queryByTestId('code-routing-activity')).toBeNull();
    expect(screen.getByText(/failed payload/)).toBeVisible();
  });

  it('timeline rows stay nested under the code session, out of the root filter', () => {
    const anchor = chipMessage();
    expect(filterMessagesForSubAgent([anchor, SENT(), RECEIVED()], undefined)).toEqual([anchor]);
    expect(filterMessagesForSubAgent([anchor, SENT()], 'task-1')).toHaveLength(1);
  });

  it('a timeline row in a trajectory list renders as an agent-to-agent row, not a chip', () => {
    renderItems([SENT()]);
    const row = screen.getByTestId('a2a-row');
    expect(row).toHaveTextContent('Codex → RoseTests pass; ready to merge.');
    expect(row.closest('[data-message-kind="agent-to-agent"]')).not.toBeNull();
    expect(screen.queryByText(/Spinning up/)).not.toBeInTheDocument();
  });

  it('a USER row from a code agent is an agent message, never a user bubble', () => {
    const { container } = renderItems([
      a2aInboundUserMessage('message', 'Merged into rose-ui/polish.'),
    ]);
    const row = screen.getByTestId('a2a-row');
    expect(row).toHaveAttribute('data-a2a-kind', 'message');
    expect(row).toHaveTextContent('Codex → RoseMerged into rose-ui/polish.');
    expect(within(row).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.queryByText(/\[Message from Codex/)).not.toBeInTheDocument();
    expect(container.querySelector('.items-end')).toBeNull();
  });

  it('a question routed to a parent agent renders inline with the "<agent> asks" header and is not pinned', () => {
    const question = a2aInboundUserMessage(
      'question',
      'Should the speed button default to Ultrafast?',
      { id: 'research-agent', label: 'Research agent' },
    );
    renderItems([question], {
      currentAnimatingId: question.message_id,
      selectedAgentId: 'research-agent',
      after: <PinnedQuestionMount />,
    });
    const row = screen.getByTestId('a2a-row');
    expect(row).toHaveAttribute('data-a2a-kind', 'question');
    expect(within(row).getByText('Codex asks')).toHaveClass('font-medium');
    expect(within(row).getByText('→ Research agent')).toBeInTheDocument();
    expect(within(row).getByText('Should the speed button default to Ultrafast?')).toBeVisible();
    expect(screen.queryByText(/Answer with send_message_to_agent/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument();
  });

  it('completes the typing chain when the agent row is the animating message', () => {
    const row = a2aInboundUserMessage('message', 'hi');
    const done = vi.fn();
    renderItems([row], { currentAnimatingId: row.message_id, onAnimationComplete: done });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('flag off: USER a2a rows keep the stock user bubble and timeline rows render no a2a rows', () => {
    const { container } = renderItems(
      [a2aInboundUserMessage('message', 'Merged into rose-ui/polish.')],
      { roseDesktop: false },
    );
    expect(screen.queryByTestId('a2a-row')).not.toBeInTheDocument();
    expect(screen.getByText(/\[Message from Codex, agent_id task-1\./)).toBeInTheDocument();
    expect(container.querySelector('.items-end')).not.toBeNull();

    const chip = renderChip([chipMessage(), SENT(), RECEIVED()], false);
    expect(within(chip.container).queryByTestId('a2a-row')).not.toBeInTheDocument();
  });

  it('adapter: a2a.text (raw words) wins over the framed row text; older rows strip the frame', () => {
    const explicit = a2aInboundUserMessage('message', 'raw sender text');
    expect(explicit.text).toMatch(/^\[Message from Codex/);
    expect(parseAgentToAgentMessage(explicit)?.text).toBe('raw sender text');
    const legacy = a2aInboundUserMessage('message', 'pre-ea93d584 row');
    const { text: _dropped, ...legacyA2a } = legacy.metadata?.a2a as Record<string, unknown>;
    expect(_dropped).toBe('pre-ea93d584 row');
    legacy.metadata = { ...legacy.metadata, a2a: legacyA2a };
    expect(parseAgentToAgentMessage(legacy)?.text).toBe('pre-ea93d584 row');
    const broken = a2aInboundUserMessage('message', 'x');
    broken.metadata = { ...broken.metadata, a2a: { message_id: 'm', from: { id: 'a' } } };
    expect(parseAgentToAgentMessage(broken)).toBeNull();
    const titled = a2aInboundUserMessage('message', 'x', { id: 'sub', label: 'Research agent' });
    expect(parseAgentToAgentMessage(titled)?.to.label).toBe('Research agent');
  });
});

describe('contract adapter: absent or malformed metadata keeps the stock behavior', () => {
  it('rejects code_agent snapshots missing a required field', () => {
    expect(parseCodeAgentMeta(undefined)).toBeNull();
    expect(parseCodeAgentMeta('live')).toBeNull();
    expect(parseCodeAgentMeta(codeAgent({ provider: 'gemini' }))).toBeNull();
    expect(parseCodeAgentMeta(codeAgent({ state: 'sleeping' }))).toBeNull();
    // W5b (f78bf8aa8): 'paused' is a contract state (resumable session).
    expect(parseCodeAgentMeta(codeAgent({ state: 'paused' }))?.state).toBe('paused');
    expect(parseCodeAgentMeta(codeAgent({ task_id: '' }))).toBeNull();
    expect(parseCodeAgentMeta(codeAgent({ started_at: null }))).toBeNull();
    expect(parseCodeAgentMeta(codeAgent({ target: 'mars' }))?.target).toBe('cloud');
    expect(parseCodeAgentMeta(codeAgent({ failure_kind: 'other' }))?.failure_kind).toBeUndefined();
  });

  it("drops malformed transcript events and keeps only the task's rows", () => {
    const events = collectCodeAgentEvents(
      [
        eventsMessage([
          { type: 'tool', ts: 3 },
          { type: 'message', ts: 2 },
          { type: 'message', text: 'no time' },
          { type: 'message', ts: 2, text: 'second' },
          { type: 'thinking', ts: 1, text: 'first' },
        ]),
        eventsMessage([{ type: 'message', ts: 0, text: 'other task' }], 'task-2'),
      ],
      'task-1',
    );
    expect(events.map((e) => e.text)).toEqual(['first', 'second']);
  });

  it('rejects pinned questions without their required fields', () => {
    expect(
      parsePinnedQuestion({ display: { ...QUESTION_DISPLAY, placement: 'inline' } }),
    ).toBeNull();
    expect(parsePinnedQuestion({ display: { ...QUESTION_DISPLAY, question_id: '' } })).toBeNull();
    expect(parsePinnedQuestion({ display: { ...QUESTION_DISPLAY, allow_other: false } })).toEqual(
      expect.objectContaining({ allow_other: false, options: expect.any(Array) }),
    );
  });

  it('flag on with a malformed snapshot renders the stock chip', () => {
    renderChip([chipMessage({ provider: 'gemini' })]);
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/directly…/)).not.toBeInTheDocument();
  });
});

it('only folds known healthy routing tools, preserving user delivery, approvals and unknown states', () => {
  const routing = msg({ toolName: 'send_message_to_agent', toolStatus: 'IN_PROGRESS' });
  expect(isRoutineAgentRouting(routing)).toBe(true);
  for (const metadata of [
    { toolName: 'send_message_to_user' },
    { error: true },
    { requestUserApproval: { toolApproval: true } },
    { toolStatus: 'APPROVAL_REQUIRED' },
    { isUserAttentionMessage: true },
  ])
    expect(
      isRoutineAgentRouting({
        ...routing,
        metadata: { ...routing.metadata, ...metadata } as typeof routing.metadata,
      }),
    ).toBe(false);
  const native = msg({
    toolName: 'Run',
    toolStatus: 'FINISHED',
    title: 'Run rose-agents send parent "hello"',
  });
  expect(isRoutineAgentRouting(native)).toBe(false);
  expect(isRoutineAgentRouting(native, true)).toBe(true);
  expect(
    isRoutineAgentRouting(
      {
        ...native,
        metadata: { ...native.metadata, title: 'Run echo hello; rose-agents send parent hi' },
      },
      true,
    ),
  ).toBe(false);
});
