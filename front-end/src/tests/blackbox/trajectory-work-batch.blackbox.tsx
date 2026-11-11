import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrajectoryWorkGroup } from '@/features/terminal-component-group/components/TrajectoryWorkGroup';
import { groupTrajectoryWork } from '@/features/terminal-component-group/components/trajectoryWorkGroups';
import { AgentContext } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { makeCtx } from './browser-agent-chip.fixtures';
import { msg } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';
import { extractUpdatePayload } from '@/lib/realtime-types/extractors';
import { handleUpdateAgent } from '@/features/agent-context/hooks/realtimeHandlers';
import { reconcileAgent } from '@/lib/progressEstimate';
import type { AgentDetail } from '@/lib/api';
vi.mock('@/components/ThinkingAnimation', () => ({ default: () => null }));
const start = Date.UTC(2026, 9, 21, 12);
function activity(toolName: string, id = toolName, at = start, toolStatus = 'IN_PROGRESS') {
  return msg(
    {
      toolName,
      toolCallId: id,
      toolStatus,
      title: toolName === 'cloud_agent' ? 'Creating Cloud Agent' : toolName,
    },
    { message_id: id, timestamp: new Date(at).toISOString() },
  );
}
/** Rose's own inbound agent message row (`metadata.agentMessage`), USER or ASSISTANT role. */
function fromRoot(id: string, at: number, role: 'USER' | 'ASSISTANT' = 'USER') {
  return msg(
    {
      agentMessage: true,
      messageType: 'MESSAGE',
      fromAgentId: 'root-agent',
      fromAgentPath: '/root',
    },
    {
      message_id: id,
      role,
      text: `Message Type: MESSAGE\nTask name: worker\nSender: /root\nPayload:\nUpdate ${id}`,
      timestamp: new Date(at).toISOString(),
    },
  );
}
function group(messages = [activity('read_file')], status = 'ACTIVE') {
  return [
    ...groupTrajectoryWork(
      messages,
      status,
      new Date(Date.now()).toISOString(),
    ).groupsByLeadId.values(),
  ][0];
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('current work batch elapsed time and ring semantics', () => {
  it('keeps the captured database pause at 1h 21m and accepts the canonical refresh', () => {
    // Retained realtime.messages frames for 77783ad2 on 2026-11-07. The database
    // trigger serializes TIMESTAMP WITHOUT TIME ZONE, unlike the API emitter.
    const id = '77783ad2-f547-473d-8191-a98c173edc97';
    const rows = [activity('read_file', 'work', Date.parse('2026-11-07T18:58:57.979Z'))];
    let agent = {
      ...makeCtx(rows).agent,
      agent_id: id,
      status: 'ACTIVE',
      updated_at: '2026-11-07T19:46:29.358Z',
      user_control_revision: 0,
    } as AgentDetail;
    const tree = () => (
      <AgentContext.Provider value={{ ...makeCtx(rows), agent, selectedAgentId: id }}>
        <MessageList showThinkingIndicator={false} />
      </AgentContext.Provider>
    );
    const view = renderWithProviders(tree());
    for (const updatedAt of ['2026-11-07T20:20:51.002', '2026-11-07T20:20:51.226']) {
      const update = extractUpdatePayload({
        payload: {
          schema: 'public',
          table: 'Agent',
          record: { id, updatedAt, status: 'PAUSED', userControlRevision: 1 },
        },
      });
      expect(update).not.toBeNull();
      handleUpdateAgent(
        update!,
        (next) => {
          agent = (typeof next === 'function' ? next(agent) : next)!;
        },
        () => {},
      );
      view.rerender(tree());
      expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent(
        'Interrupted after 1h 21m',
      );
      expect(agent.updated_at).toBe(`${updatedAt}Z`);
    }
    const refreshed = { ...agent, title: 'Refreshed', updated_at: '2026-11-07T20:20:51.226Z' };
    expect(reconcileAgent(agent, refreshed)).toMatchObject({ title: 'Refreshed' });
  });

  it('shows elapsed time, keeps its start when the activity rotates, and stops its timer after compression', () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 2000);
    const messages = [activity('read_file')];
    const view = render(<TrajectoryWorkGroup group={group(messages)} renderMessage={() => null} />);
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('2.0s');
    expect(screen.queryByText('Live')).toBeNull();
    // Andy 2026-10-28: no little spinner in the working row; the arrow + icon carry it.
    expect(screen.queryByTestId('tool-batch-progress-ring')).toBeNull();
    expect(screen.getByTestId('trajectory-disclosure')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('3.5s');
    messages.push(activity('web_search', 'next-call', start + 3000));
    view.rerender(<TrajectoryWorkGroup group={group(messages)} renderMessage={() => null} />);
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('3.5s');
    view.rerender(
      <TrajectoryWorkGroup group={group(messages, 'COMPLETED')} renderMessage={() => null} />,
    );
    expect(screen.queryByTestId('trajectory-batch-elapsed')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the batch clock running when one explore finishes while another in the batch continues', () => {
    vi.useFakeTimers();
    const explore = (id: string, at: number, toolStatus: string, title = 'Exploring') =>
      msg(
        {
          toolName: 'spawn_agent',
          agentType: 'explore',
          taskId: id,
          toolCallId: id,
          toolStatus,
          title,
        },
        { message_id: `${id}:${toolStatus}`, timestamp: new Date(at).toISOString() },
      );
    const notification = msg(
      {
        toolName: 'agent_notification',
        agentNotification: true,
        messageType: 'FINAL_ANSWER',
        backgroundTaskId: 'first',
      },
      {
        role: 'USER',
        text: 'Message Type: FINAL_ANSWER',
        timestamp: new Date(start + 36_600).toISOString(),
      },
    );
    const rows = [
      explore('first', start, 'IN_PROGRESS'),
      explore('second', start + 20, 'IN_PROGRESS'),
    ];
    const ctx = (messages: typeof rows) => ({
      ...makeCtx(messages),
      agent: { id: 'agent-1', status: 'ACTIVE', updated_at: messages.at(-1)!.timestamp } as never,
    });
    const tree = (messages: typeof rows) => (
      <AgentContext.Provider value={ctx(messages)}>
        <MessageList showThinkingIndicator={false} />
      </AgentContext.Provider>
    );
    vi.setSystemTime(start + 35_600);
    const view = renderWithProviders(tree(rows));
    act(() => vi.advanceTimersByTime(50));
    rows.push(explore('first', start + 35_650, 'FINISHED', 'Read-only research'));
    view.rerender(tree([...rows]));
    act(() => vi.advanceTimersByTime(1050));
    rows.push(notification);
    view.rerender(tree([...rows]));
    const group = screen.getByTestId('trajectory-work-group');
    expect(group).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('36.7s');
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('41.7s');
    expect(group).toHaveAttribute('data-state', 'running');
  });
  it('folds inbound agent messages into ONE "Worked for" batch instead of splitting it', () => {
    // The mobile transcript: 2 activities, Message from /root, 3 activities,
    // Message from /root, 1 activity rendered as three folds; now one.
    const minute = 60_000;
    const done = (toolName: string, id: string, at: number) =>
      activity(toolName, id, at, 'FINISHED');
    const rows = [
      done('read_file', 'a1', start),
      done('grep', 'a2', start + minute),
      fromRoot('from-root-1', start + 5 * minute + 8_000),
      done('read_file', 'a3', start + 6 * minute),
      done('grep', 'a4', start + 7 * minute),
      done('read_file', 'a5', start + 8 * minute),
      fromRoot('from-root-2', start + 8 * minute + 23_000, 'ASSISTANT'),
      done('read_file', 'a6', start + 8 * minute + 51_000),
    ];
    const ctx = {
      ...makeCtx(rows),
      agent: {
        id: 'agent-1',
        status: 'COMPLETED',
        updated_at: new Date(start + 9 * minute).toISOString(),
      } as never,
    };
    renderWithProviders(
      <AgentContext.Provider value={ctx}>
        <MessageList showThinkingIndicator={false} />
      </AgentContext.Provider>,
    );
    expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
    const batch = screen.getByTestId('trajectory-work-group');
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent('Worked for 9m 00s');
    expect(batch).toHaveTextContent('8 activities');
    expect(screen.queryByTestId('inbound-agent-row')).toBeNull();
    fireEvent.click(within(batch).getByRole('button'));
    const history = within(batch).getByTestId('trajectory-work-history');
    expect(
      within(history)
        .getAllByTestId('inbound-agent-row-title')
        .map((title) => title.textContent),
    ).toEqual(['Message from /root', 'Message from /root']);
    expect(
      [...history.querySelectorAll('[data-message-id]')].map((el) =>
        el.getAttribute('data-message-id'),
      ),
    ).toEqual(rows.map((row) => row.message_id));
  });
  it('shows an inbound agent message as the running batch line with its mail icon', () => {
    const rows = [activity('read_file', 'before'), fromRoot('latest', start + 1000)];
    const { container } = render(
      <TrajectoryWorkGroup group={group(rows)} renderMessage={() => null} />,
    );
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent('Message from /root');
    expect(container.querySelector('.lucide-mail')).not.toBeNull();
  });
  it('ticks only the elapsed text while an open running batch shows its history', () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 2000);
    const messages = Array.from({ length: 20 }, (_, i) =>
      activity('read_file', `step-${i}`, start + i),
    );
    const renderMessage = vi.fn(() => null);
    render(<TrajectoryWorkGroup group={group(messages)} renderMessage={renderMessage} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('trajectory-work-history')).toBeInTheDocument();
    const rendersWhenOpened = renderMessage.mock.calls.length;
    expect(rendersWhenOpened).toBeGreaterThanOrEqual(20);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('3.0s');
    expect(renderMessage.mock.calls.length).toBe(rendersWhenOpened);
  });
  it('stays on the newest page while open as a running batch crosses a multiple of 50', () => {
    const batch = (n: number) =>
      group(Array.from({ length: n }, (_, i) => activity('read_file', `grow-${i}`, start + i)));
    const show = (m: { message_id: string }) => <span>{m.message_id}</span>;
    const view = render(<TrajectoryWorkGroup group={batch(100)} renderMessage={show} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('grow-99')).toBeInTheDocument();
    view.rerender(<TrajectoryWorkGroup group={batch(101)} renderMessage={show} />);
    // A new third page appeared; the open view follows it (the 50 newest: 51–100).
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getByText('grow-100')).toBeInTheDocument();
    expect(screen.getByText('grow-51')).toBeInTheDocument();
    expect(screen.queryByText('grow-50')).toBeNull();
    // An older page stays one page back from the newest: pages count back from
    // the newest activity, so its rows slide by one as each new activity lands.
    fireEvent.click(screen.getByRole('button', { name: 'Previous activities' }));
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByText('grow-1')).toBeInTheDocument();
    expect(screen.getByText('grow-50')).toBeInTheDocument();
    view.rerender(<TrajectoryWorkGroup group={batch(102)} renderMessage={show} />);
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.queryByText('grow-1')).toBeNull();
    expect(screen.getByText('grow-2')).toBeInTheDocument();
    expect(screen.getByText('grow-51')).toBeInTheDocument();
  });
  it('opens a long running batch on its latest page and names the history it controls', () => {
    const messages = Array.from({ length: 120 }, (_, i) =>
      activity('read_file', `long-${i}`, start + i),
    );
    render(<TrajectoryWorkGroup group={group(messages)} renderMessage={() => null} />);
    const toggle = screen.getByRole('button');
    expect(toggle).not.toHaveAttribute('aria-controls');
    fireEvent.click(toggle);
    // 50 a page, anchored at the newest: the latest page holds the 50 most recent.
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getAllByTestId('trajectory-history-entry')).toHaveLength(50);
    expect(toggle).toHaveAttribute(
      'aria-controls',
      screen.getByTestId('trajectory-work-history').id,
    );
  });
  it.each([
    ['thought', 'lightbulb'],
    ['cloud_agent', 'cloud'],
    ['agent_init', 'play'],
  ])('never shows a tool-batch ring for %s', (tool, icon) => {
    const { container } = render(
      <TrajectoryWorkGroup group={group([activity(tool)])} renderMessage={() => null} />,
    );
    expect(screen.queryByTestId('tool-batch-progress-ring')).toBeNull();
    expect(container.querySelector('.lucide-loader-circle')).toBeNull();
    expect(container.querySelector(`.lucide-${icon}`)).not.toBeNull();
  });
  it("keeps the folded rows' tool identity on the compressed row", () => {
    const plan = msg(
      {
        toolName: 'cloud_agent',
        toolCallId: 'cloud',
        toolStatus: 'IN_PROGRESS',
        title: 'Creating Cloud Agent',
        startPhase: 'plan',
      },
      { message_id: 'cloud', timestamp: new Date(start).toISOString() },
    );
    const search = msg(
      { toolName: 'web_search', toolCallId: 'search', toolStatus: 'FINISHED', title: 'Search' },
      { message_id: 'search', timestamp: new Date(start + 1000).toISOString() },
    );
    render(<TrajectoryWorkGroup group={group([plan, search])} renderMessage={() => null} />);
    const row = screen.getByTestId('trajectory-work-group');
    expect(row).toHaveAttribute(
      'data-tool-statuses',
      'cloud_agent:IN_PROGRESS web_search:FINISHED',
    );
    expect(row).toHaveAttribute('data-agent-start-phase', 'plan');
    expect(row).toHaveAttribute('data-activity-kinds', 'work');
    cleanup();
    render(<TrajectoryWorkGroup group={group()} renderMessage={() => null} />);
    expect(screen.getByTestId('trajectory-work-group')).not.toHaveAttribute(
      'data-agent-start-phase',
    );
  });
  it('thinking is a stock activity row and never shows a token count estimated from text', () => {
    const live = msg(
      { toolName: 'thought', title: 'Thinking', toolStatus: 'IN_PROGRESS', ephemeral: true },
      { message_id: 'streaming:thinking', timestamp: '' },
    );
    render(<TrajectoryWorkGroup group={group([live])} renderMessage={() => null} />);
    const line = () => screen.getByTestId('trajectory-activity-line');
    expect(line()).toHaveTextContent(/^Thinking$/);
    expect(screen.getByTestId('trajectory-activity-icon')).toHaveClass('lucide-lightbulb');
    expect(screen.queryByTestId('thinking-indicator')).toBeNull();
    cleanup();
    const thought = msg(
      {},
      {
        role: 'ASSISTANT',
        message_id: 'thought',
        text: 'x'.repeat(400),
        timestamp: new Date(start).toISOString(),
      },
    );
    render(<TrajectoryWorkGroup group={group([thought])} renderMessage={() => null} />);
    expect(line()).toHaveTextContent(/^Thinking$/);
    expect(line().querySelector('.lucide-arrow-down')).toBeNull();
    expect(screen.getByTestId('trajectory-activity-icon')).toHaveClass('lucide-lightbulb');
  });
  it('starts the clock optimistically for a missing timestamp and never jumps when it arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 10_000);
    const untimed = { ...activity('read_file'), timestamp: '' };
    const view = render(
      <TrajectoryWorkGroup group={group([untimed])} renderMessage={() => null} />,
    );
    const elapsed = () => screen.getByTestId('trajectory-batch-elapsed');
    expect(elapsed()).toHaveTextContent('0.0s');
    act(() => vi.advanceTimersByTime(1500));
    expect(elapsed()).toHaveTextContent('1.5s');
    // The server start (10 s earlier by its clock) keeps the client anchor: no jump, no reset.
    view.rerender(
      <TrajectoryWorkGroup group={group([activity('read_file')])} renderMessage={() => null} />,
    );
    expect(elapsed()).toHaveTextContent('1.5s');
    act(() => vi.advanceTimersByTime(500));
    expect(elapsed()).toHaveTextContent('2.0s');
  });
});
