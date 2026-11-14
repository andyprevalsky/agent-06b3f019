import { createElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import type { Message } from '@/lib/api';
import { msg, WithAgent } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, n)).toISOString();
function comm(id: string, row = id) {
  return msg(
    {
      a2a: {
        message_id: id,
        kind: 'message',
        from: { id: 'root', kind: 'agent', label: 'Rose' },
        to: { id: 'worker', kind: 'agent', label: 'Researcher' },
        text: `Coordinate ${id}`,
      },
    },
    { message_id: row, role: 'USER', timestamp: stamp(1) },
  );
}
function work(id: string) {
  return msg(
    { toolName: 'read_file', toolCallId: id, title: `Check ${id}`, toolStatus: 'FINISHED' },
    { message_id: id, text: `Work ${id}`, timestamp: stamp(2) },
  );
}
function view(messages: Message[], status = 'ACTIVE') {
  return createElement(
    WithAgent,
    { messages, selectedAgentId: 'root' },
    createElement(MessageListItems, {
      filteredMessages: messages,
      groupAgentMessages: true,
      compressWork: true,
      workStatus: status,
      workEndedAt: stamp(30),
      currentAnimatingId: null,
      onAnimationComplete: () => {},
      selectedAgentId: 'root',
      exploreStepMap: new Map(),
      waitForCheckMap: new Map(),
      streamingMetricsBySubAgentId: new Map(),
    }),
  );
}
describe('one ordered live trajectory carousel', () => {
  it('replaces comms → work → comms → work in ONE stable row that expands to the work so far and stays open through completion', () => {
    const messages = [comm('first')];
    const v = renderWithProviders(view(messages));
    const row = screen.getByTestId('trajectory-work-group');
    const key = row.getAttribute('data-group-key');
    const toggle = within(row).getByRole('button');
    for (const next of [work('first-work'), comm('second')]) {
      messages.push(next);
      v.rerender(view([...messages]));
      expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
      expect(row).toHaveAttribute('data-group-key', key);
      expect(toggle).toBeEnabled();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
      expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
      expect(screen.queryByTestId('a2a-row')).toBeNull();
    }
    // While the batch runs, the user opens it and sees what was done so far.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const history = screen.getByTestId('trajectory-work-history');
    const ids = () =>
      [...history.querySelectorAll('[data-message-id]')].map((el) =>
        el.getAttribute('data-message-id'),
      );
    expect(ids()).toEqual(['first', 'first-work', 'second']);
    // A new in-progress step joins the open history; the live line keeps running.
    messages.push(
      msg(
        {
          toolName: 'read_file',
          toolCallId: 'second-work',
          title: 'Check second-work',
          toolStatus: 'IN_PROGRESS',
        },
        { message_id: 'second-work', text: 'Work second-work', timestamp: stamp(2) },
      ),
    );
    v.rerender(view([...messages]));
    expect(ids()).toEqual(['first', 'first-work', 'second', 'second-work']);
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent('Check second-work');
    expect(within(row).getByTestId('trajectory-batch-elapsed')).toBeInTheDocument();
    expect(screen.getByTestId('trajectory-activity-line')).not.toHaveTextContent('Coordinate');
    // Completion keeps the user's open state and the same history node (no collapse/flash).
    messages[messages.length - 1] = work('second-work');
    v.rerender(view([...messages], 'COMPLETED'));
    expect(row).toHaveTextContent('Worked for 29.0s');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('trajectory-work-history')).toBe(history);
    expect(within(history).getAllByTestId('trajectory-history-entry')).toHaveLength(4);
    expect(within(history).getAllByTestId('a2a-row')[0]).toHaveAttribute(
      'data-a2a-direction',
      'sent',
    );
    expect(ids()).toEqual(['first', 'first-work', 'second', 'second-work']);
    fireEvent.click(toggle);
    expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
  });
  it.each([
    ['its thought text', true],
    ['only its tool call', false],
  ])('keeps an opened live batch open when the streaming thought persists as %s', (_, text) => {
    const live = msg(
      { toolName: 'thought', title: 'Thinking', toolStatus: 'IN_PROGRESS', ephemeral: true },
      { message_id: 'streaming:thinking', timestamp: stamp(1) },
    );
    const v = renderWithProviders(view([live]));
    const toggle = within(screen.getByTestId('trajectory-work-group')).getByRole('button');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const persisted = msg(
      {},
      {
        role: 'ASSISTANT',
        message_id: 'persisted-thought',
        text: text ? 'Plan it.' : '',
        timestamp: stamp(1),
      },
    );
    v.rerender(view([persisted, work('after-thought')]));
    const row = screen.getByTestId('trajectory-work-group');
    expect(within(row).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getAllByTestId('trajectory-history-entry')).toHaveLength(text ? 2 : 1);
  });
  const boundary = (id: string, at: number) =>
    msg(
      { toolName: 'send_message_to_user', toolStatus: 'FINISHED', isUserAttentionMessage: true },
      { message_id: id, text: `Update ${id}`, timestamp: stamp(at) },
    );
  const rowFor = (id: string) =>
    document
      .querySelector(`[data-message-id="${id}"]`)!
      .closest('[data-testid="trajectory-work-group"]') as HTMLElement;
  it('keeps the opened batch open when a late boundary splits an earlier batch', () => {
    const [a1, a2, c1] = [work('a1'), work('a2'), work('c1')];
    const v = renderWithProviders(view([a1, a2, boundary('b1', 3), c1]));
    const groups = () => screen.getAllByTestId('trajectory-work-group');
    expect(groups()).toHaveLength(2);
    fireEvent.click(within(groups()[1]).getByRole('button'));
    expect(rowFor('c1')).not.toBeNull();
    v.rerender(view([a1, boundary('late', 2), a2, boundary('b1', 3), c1]));
    expect(groups()).toHaveLength(3);
    const toggles = groups().map((group) => within(group).getAllByRole('button')[0]);
    expect(toggles.map((toggle) => toggle.getAttribute('aria-expanded'))).toEqual([
      'false',
      'false',
      'true',
    ]);
    expect(rowFor('c1')).toBe(groups()[2]);
    expect(within(groups()[2]).getByTestId('trajectory-work-history')).toContainElement(
      document.querySelector('[data-message-id="c1"]') as HTMLElement,
    );
  });
  it('keeps the opened batch open when an earlier single-row batch disappears', () => {
    const [orphan, b1, b2] = [work('orphan'), work('b1-work'), work('b2-work')];
    const v = renderWithProviders(view([orphan, boundary('b0', 3), b1, b2]));
    const groups = () => screen.getAllByTestId('trajectory-work-group');
    fireEvent.click(within(groups()[1]).getByRole('button'));
    v.rerender(view([boundary('b0', 3), b1, b2]));
    expect(groups()).toHaveLength(1);
    expect(within(groups()[0]).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'true');
    expect(within(groups()[0]).getAllByTestId('trajectory-history-entry')).toHaveLength(2);
  });
  it.each([
    msg({}, { role: 'ASSISTANT', message_id: 'empty-assistant', text: '' }),
    msg({}, { role: 'USER', message_id: 'empty-user', text: '' }),
    msg(
      { toolName: 'request_user_approval', requestUserApproval: { toolApproval: {} } },
      { message_id: 'inbox-approval' },
    ),
    msg({ toolName: 'gate', gate: { id: 'gate' } }, { message_id: 'external-gate' }),
  ])('does not split adjacent work or add blank spacing for hidden row $message_id', (hidden) => {
    renderWithProviders(view([work('before-hidden'), hidden, work('after-hidden')], 'COMPLETED'));
    const group = screen.getByTestId('trajectory-work-group');
    expect(group).toHaveTextContent('2 activities');
    expect(document.querySelector(`[data-message-id="${hidden.message_id}"]`)).toBeNull();
    fireEvent.click(within(group).getByRole('button'));
    expect(screen.getAllByTestId('trajectory-history-entry')).toHaveLength(2);
  });

  it.each(['FINISHED', 'ERROR'])(
    'folds terminal Browser Agent %s results and keeps their card accessible in history',
    async (toolStatus) => {
      const browser = msg(
        {
          toolName: 'spawn_browser_agent',
          toolCallId: 'browser-result',
          task_id: 'browser-task',
          action_type: 'task_complete',
          toolStatus,
          error: toolStatus === 'ERROR',
        },
        {
          message_id: 'browser-result',
          text: 'User rejected the approval request',
          timestamp: stamp(3),
        },
      );
      renderWithProviders(
        view([work('before-browser'), browser, work('after-browser')], 'COMPLETED'),
      );
      const group = screen.getByTestId('trajectory-work-group');
      expect(group).toHaveTextContent('3 activities');
      expect(screen.queryByTestId('browser-agent-chip-header')).toBeNull();
      fireEvent.click(within(group).getByRole('button'));
      const history = screen.getByTestId('trajectory-work-history');
      const browserHeader = await within(history).findByTestId('browser-agent-chip-header');
      expect(browserHeader).toHaveTextContent('Browser Agent');
      fireEvent.click(browserHeader);
      expect(await within(history).findByText('User rejected the approval request')).toBeVisible();
    },
  );

  /** Rose's own inbound agent message row (`metadata.agentMessage`). */
  const fromRoot = (id: string, role: 'USER' | 'ASSISTANT' = 'USER') =>
    msg(
      {
        agentMessage: true,
        messageType: 'MESSAGE',
        fromAgentId: 'root-agent',
        fromAgentPath: '/root/outreach',
      },
      {
        message_id: id,
        role,
        text: `Message Type: MESSAGE\nTask name: worker\nSender: /root/outreach\nPayload:\nNote ${id}`,
        timestamp: stamp(3),
      },
    );
  const historyIds = (history: HTMLElement) =>
    [...history.querySelectorAll('[data-message-id]')].map((el) =>
      el.getAttribute('data-message-id'),
    );
  it.each(['USER', 'ASSISTANT'] as const)(
    'folds a %s inbound agent message into the batch and keeps its Message from row in history',
    (role) => {
      renderWithProviders(
        view(
          [work('before-message'), fromRoot('from-root', role), work('after-message')],
          'COMPLETED',
        ),
      );
      expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
      const group = screen.getByTestId('trajectory-work-group');
      expect(group).toHaveTextContent('3 activities');
      expect(group).not.toHaveTextContent('exchanges');
      expect(screen.queryByTestId('inbound-agent-row')).toBeNull();
      fireEvent.click(within(group).getByRole('button'));
      const history = screen.getByTestId('trajectory-work-history');
      expect(historyIds(history)).toEqual(['before-message', 'from-root', 'after-message']);
      const row = within(history).getByTestId('inbound-agent-row');
      expect(row).toHaveTextContent('Message from /root/outreach');
      expect(screen.queryByText('Thought')).toBeNull();
      fireEvent.click(within(row).getByRole('button'));
      expect(within(history).getByText('Note from-root')).toBeVisible();
    },
  );
  it('keeps an opened running batch open, with the same key, when an agent message joins it', () => {
    const human = msg({}, { message_id: 'human', role: 'USER', text: 'Research March' });
    const messages = [human, work('first-check')];
    const v = renderWithProviders(view(messages));
    const row = screen.getByTestId('trajectory-work-group');
    const key = row.getAttribute('data-group-key');
    const toggle = within(row).getByRole('button');
    fireEvent.click(toggle);
    for (const next of [fromRoot('mid-batch'), work('second-check')]) {
      messages.push(next);
      v.rerender(view([...messages]));
      expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
      expect(screen.getByTestId('trajectory-work-group')).toBe(row);
      expect(row).toHaveAttribute('data-group-key', key);
      expect(row).toHaveAttribute('data-state', 'running');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    expect(historyIds(screen.getByTestId('trajectory-work-history'))).toEqual([
      'first-check',
      'mid-batch',
      'second-check',
    ]);
    expect(
      screen.getByText('Research March').closest('[data-testid="trajectory-work-group"]'),
    ).toBeNull();
  });
  it('folds the actual assistant Thought → work → Thought → work rows into four activities', () => {
    const messages = [
      msg(
        {},
        {
          role: 'ASSISTANT',
          message_id: 'assistant-thought-one',
          text: 'First internal thought.',
          timestamp: stamp(1),
        },
      ),
      work('first-check'),
      msg(
        {},
        {
          role: 'ASSISTANT',
          message_id: 'assistant-thought-two',
          text: 'Second internal thought.',
          timestamp: stamp(3),
        },
      ),
      { ...work('second-check'), timestamp: stamp(4) },
    ];
    const rendered = renderWithProviders(view(messages));
    expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
    expect(screen.queryByText('Thought')).toBeNull();
    expect(screen.queryByText('First internal thought.')).toBeNull();
    expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
    rendered.rerender(view(messages, 'COMPLETED'));
    const group = screen.getByTestId('trajectory-work-group');
    expect(group).toHaveTextContent('Worked for 29.0s');
    expect(group).toHaveTextContent('4 activities');
    fireEvent.click(within(group).getByRole('button'));
    const history = screen.getByTestId('trajectory-work-history');
    expect(within(history).getAllByTestId('trajectory-history-entry')).toHaveLength(4);
    expect(
      [...history.querySelectorAll('[data-message-id]')].map((el) =>
        el.getAttribute('data-message-id'),
      ),
    ).toEqual(messages.map((message) => message.message_id));
  });

  it.each(['ACTIVE', 'COMPLETED'])(
    'folds thoughts into worked history while keeping the plan outside for %s',
    async (status) => {
      const thought = msg(
        { toolName: 'thought', toolCallId: 'thinking', toolStatus: 'FINISHED', title: 'Thinking' },
        {
          message_id: 'thought-before-plan',
          text: 'Inspect the evidence first.',
          timestamp: stamp(1),
        },
      );
      const plan = msg(
        {
          toolName: 'set_plan',
          toolCallId: 'plan',
          toolStatus: 'FINISHED',
          data: { title: 'User-facing plan', content: 'Build then verify.', tasks: [] },
        },
        { message_id: 'visible-plan', timestamp: stamp(5) },
      );
      renderWithProviders(view([thought, plan, work('after-plan')], status));
      const planTitle = await screen.findByText('User-facing plan');
      expect(planTitle.closest('[data-testid="trajectory-work-group"]')).toBeNull();
      expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
      const firstGroup = screen.getAllByTestId('trajectory-work-group')[0];
      expect(firstGroup).toHaveTextContent('Worked for 4.0s');
      expect(firstGroup.querySelector('[data-message-id="thought-before-plan"]')).toBeNull();
      fireEvent.click(within(firstGroup).getByRole('button'));
      const history = screen.getByTestId('trajectory-work-history');
      expect(history.querySelector('[data-message-id="thought-before-plan"]')).not.toBeNull();
      expect(history.querySelector('[data-message-id="visible-plan"]')).toBeNull();
      expect(planTitle).toBeVisible();
    },
  );

  it('deduplicates mirrors and pages the ordered history, 50 a page, newest page first', () => {
    const messages = Array.from({ length: 120 }, (_, i) => [
      comm(String(i)),
      comm(String(i), `mirror-${i}`),
    ]).flat();
    renderWithProviders(view(messages, 'COMPLETED'));
    const row = screen.getByTestId('trajectory-work-group');
    expect(row).toHaveTextContent('120 activities · 120 exchanges');
    fireEvent.click(within(row).getByRole('button'));
    // A finished batch opens on its most recent page too: the 50 newest (70–119).
    expect(screen.getAllByTestId('trajectory-history-entry')).toHaveLength(50);
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getByText('Coordinate 119')).toBeInTheDocument();
    expect(screen.getByText('Coordinate 70')).toBeInTheDocument();
    expect(screen.queryByText('Coordinate 69')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous activities' }));
    expect(screen.getAllByTestId('trajectory-history-entry')).toHaveLength(50);
    expect(screen.getByText('Coordinate 20')).toBeInTheDocument();
    expect(screen.queryByText('Coordinate 19')).toBeNull();
  });
  it('keeps human requests, questions and results outside while internal failures fold', () => {
    const human = msg({}, { message_id: 'human', role: 'USER', text: 'Build the report' });
    const answer = msg(
      { toolName: 'send_message_to_user', isUserAttentionMessage: true },
      { message_id: 'final', text: 'Report ready', timestamp: stamp(20) },
    );
    const failure = msg(
      { toolName: 'execute', error: true },
      { message_id: 'failure', text: 'Permission denied', timestamp: stamp(25) },
    );
    renderWithProviders(
      view([human, comm('before'), work('read'), answer, comm('after'), failure], 'FAILED'),
    );
    expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(2);
    expect(screen.getByText('Build the report')).toBeInTheDocument();
    expect(screen.getByText('Report ready')).toBeInTheDocument();
    for (const id of ['human', 'final'])
      expect(
        document
          .querySelector(`[data-message-id="${id}"]`)
          ?.closest('[data-testid="trajectory-work-group"]'),
      ).toBeNull();
  });
  it('folds Plan required into work while the actual plan stays visible outside', async () => {
    const required = msg(
      {
        toolName: 'attempt_completion',
        toolCallId: 'rejected-completion',
        toolStatus: 'ERROR',
        error: true,
        title: '❌ Plan required',
      },
      {
        message_id: 'plan-required',
        text: 'You must call set_plan before attempt_completion in PLAN phase',
        timestamp: stamp(3),
      },
    );
    const plan = msg(
      {
        toolName: 'set_plan',
        toolStatus: 'FINISHED',
        data: { title: 'Actual execution plan', content: 'Build then check.', tasks: [] },
      },
      { message_id: 'actual-plan', timestamp: stamp(5) },
    );
    renderWithProviders(view([work('before-required'), required, work('after-required'), plan]));
    const group = screen.getByTestId('trajectory-work-group');
    expect(group).toHaveTextContent('3 activities');
    expect(screen.queryByText('Plan required')).toBeNull();
    const title = await screen.findByText('Actual execution plan');
    expect(title.closest('[data-testid="trajectory-work-group"]')).toBeNull();
    fireEvent.click(within(group).getByRole('button'));
    expect(
      await within(screen.getByTestId('trajectory-work-history')).findByText('Plan required'),
    ).toBeVisible();
  });

  it.each(['completion_summary', 'complete'])(
    'keeps canonical %s finals visible before and after terminal status',
    async (toolName) => {
      const final = msg(
        {
          toolName,
          toolStatus: 'FINISHED',
          isFinalSummary: true,
          completionSummary: {
            summary: 'Completed the mission',
            outputs: [],
            toolUsage: [],
            totalToolCalls: 2,
            durationSeconds: 20,
            costDollars: 0,
          },
        },
        { message_id: 'canonical-final', timestamp: stamp(20) },
      );
      const messages = [comm('before-final'), work('final-check'), final];
      const rendered = renderWithProviders(view(messages));
      for (const status of ['ACTIVE', 'COMPLETED']) {
        rendered.rerender(view(messages, status));
        await waitFor(() => expect(screen.getByText('Completed the mission')).toBeVisible());
        expect(
          screen
            .getByText('Completed the mission')
            .closest('[data-testid="trajectory-work-group"]'),
        ).toBeNull();
        expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
        expect(
          within(screen.getByTestId('trajectory-work-group')).getByRole('button'),
        ).toBeEnabled();
      }
    },
  );
  it('keeps a true batch failure after its separate user-facing report', () => {
    const failure = msg(
      { toolName: 'read_file', toolStatus: 'ERROR', error: true },
      { message_id: 'failed-read', text: 'Read failed.', timestamp: stamp(1) },
    );
    const report = msg(
      { toolName: 'send_message_to_user', toolStatus: 'FINISHED', isUserAttentionMessage: true },
      {
        message_id: 'failure-report',
        text: 'The task ended after the read failed.',
        timestamp: stamp(3),
      },
    );
    renderWithProviders(view([failure, report], 'FAILED'));
    const group = screen.getByTestId('trajectory-work-group');
    expect(group).toHaveTextContent('Failed after 2.0s');
    expect(
      screen
        .getByText('The task ended after the read failed.')
        .closest('[data-testid="trajectory-work-group"]'),
    ).toBeNull();
  });
  it('never assigns the following user-facing error to a completed thought batch', () => {
    const thought = msg(
      {},
      {
        role: 'ASSISTANT',
        message_id: 'finished-thought',
        text: 'Consider the next step.',
        timestamp: stamp(1),
      },
    );
    const response = msg(
      {
        toolName: 'send_message_to_user',
        toolStatus: 'ERROR',
        error: true,
        isUserAttentionMessage: true,
      },
      {
        message_id: 'outside-error',
        text: 'A separate action needs your attention.',
        timestamp: stamp(3),
      },
    );
    renderWithProviders(view([thought, response]));
    const group = screen.getByTestId('trajectory-work-group');
    expect(group).toHaveTextContent('Worked for 2.0s');
    expect(group).not.toHaveTextContent('Failed');
    expect(
      screen
        .getByText('A separate action needs your attention.')
        .closest('[data-testid="trajectory-work-group"]'),
    ).toBeNull();
  });
  it.each(['ASSISTANT', 'TOOL'] as const)(
    'does not label a completed %s thought failed because the overall agent failed',
    (role) => {
      const thought = msg(role === 'TOOL' ? { toolName: 'thought', toolStatus: 'FINISHED' } : {}, {
        role,
        text: 'A completed thought.',
        timestamp: stamp(1),
      });
      renderWithProviders(view([thought], 'FAILED'));
      expect(screen.getByTestId('trajectory-work-group')).toHaveTextContent('Worked for 29.0s');
    },
  );
  it.each(['PAUSED', 'FAILED'])('compresses %s work with honest outcome', (status) => {
    const messages = [comm('a'), work('b')];
    if (status === 'FAILED')
      messages.push(
        msg(
          { toolName: 'read_file', toolStatus: 'ERROR', error: true },
          { message_id: 'actual-failure', timestamp: stamp(3) },
        ),
      );
    renderWithProviders(view(messages, status));
    const row = screen.getByTestId('trajectory-work-group');
    expect(row).toHaveTextContent(status === 'PAUSED' ? 'Interrupted after' : 'Failed after');
    expect(within(row).getByRole('button')).toBeEnabled();
  });
});
