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
  it('replaces comms → work → comms → work in ONE stable row; history is unavailable until compressed', () => {
    const messages = [comm('first')];
    const v = renderWithProviders(view(messages));
    const row = screen.getByTestId('trajectory-work-group');
    const key = row.getAttribute('data-group-key');
    for (const next of [work('first-work'), comm('second'), work('second-work')]) {
      messages.push(next);
      v.rerender(view([...messages]));
      expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
      expect(row).toHaveAttribute('data-group-key', key);
      expect(within(row).getByRole('button')).toBeDisabled();
      fireEvent.click(within(row).getByRole('button'));
      expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
      expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
      expect(screen.queryByTestId('a2a-row')).toBeNull();
    }
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent('Check second-work');
    expect(row).not.toHaveTextContent('Coordinate first');
    v.rerender(view([...messages], 'COMPLETED'));
    expect(row).toHaveTextContent('Worked for 29.0s');
    fireEvent.click(within(row).getByRole('button'));
    const history = screen.getByTestId('trajectory-work-history');
    expect(within(history).getAllByTestId('trajectory-history-entry')).toHaveLength(4);
    expect(within(history).getAllByTestId('a2a-row')[0]).toHaveAttribute(
      'data-a2a-direction',
      'sent',
    );
    expect(
      [...history.querySelectorAll('[data-message-id]')].map((el) =>
        el.getAttribute('data-message-id'),
      ),
    ).toEqual(['first', 'first-work', 'second', 'second-work']);
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

  it('deduplicates mirrors and pages the ordered history', () => {
    const messages = Array.from({ length: 45 }, (_, i) => [
      comm(String(i)),
      comm(String(i), `mirror-${i}`),
    ]).flat();
    renderWithProviders(view(messages, 'COMPLETED'));
    const row = screen.getByTestId('trajectory-work-group');
    expect(row).toHaveTextContent('45 activities · 45 exchanges');
    fireEvent.click(within(row).getByRole('button'));
    expect(screen.getAllByTestId('trajectory-history-entry')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Next activities' }));
    expect(screen.getAllByTestId('trajectory-history-entry')).toHaveLength(20);
    expect(screen.getByText('Coordinate 20')).toBeInTheDocument();
    expect(screen.queryByText('Coordinate 0')).toBeNull();
  });
  it('keeps human requests, questions, errors and results outside compressed history', () => {
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
    for (const id of ['human', 'final', 'failure'])
      expect(
        document
          .querySelector(`[data-message-id="${id}"]`)
          ?.closest('[data-testid="trajectory-work-group"]'),
      ).toBeNull();
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
  it.each(['PAUSED', 'FAILED'])('compresses %s work with honest outcome', (status) => {
    renderWithProviders(view([comm('a'), work('b')], status));
    const row = screen.getByTestId('trajectory-work-group');
    expect(row).toHaveTextContent(status === 'PAUSED' ? 'Interrupted after' : 'Failed after');
    expect(within(row).getByRole('button')).toBeEnabled();
  });
});
