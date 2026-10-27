import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrajectoryWorkGroup } from '@/features/terminal-component-group/components/TrajectoryWorkGroup';
import { groupTrajectoryWork } from '@/features/terminal-component-group/components/trajectoryWorkGroups';
import { AgentContext } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { makeCtx } from './browser-agent-chip.fixtures';
import { msg } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';
const start = Date.UTC(2026, 9, 21, 12);
function activity(toolName: string, id = toolName, at = start) {
  return msg(
    {
      toolName,
      toolCallId: id,
      toolStatus: 'IN_PROGRESS',
      title: toolName === 'cloud_agent' ? 'Creating Cloud Agent' : toolName,
    },
    { message_id: id, timestamp: new Date(at).toISOString() },
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
  it('shows elapsed time, keeps its start when the activity rotates, and stops its timer after compression', () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 2000);
    const messages = [activity('read_file')];
    const view = render(<TrajectoryWorkGroup group={group(messages)} renderMessage={() => null} />);
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('2.0s');
    expect(screen.queryByText('Live')).toBeNull();
    // The ring is a live activity loader: it must visibly spin like every other loader.
    expect(screen.getByTestId('tool-batch-progress-ring')).toHaveClass('animate-spin');
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
  it('opens a long running batch on its latest page and names the history it controls', () => {
    const messages = Array.from({ length: 45 }, (_, i) =>
      activity('read_file', `long-${i}`, start + i),
    );
    render(<TrajectoryWorkGroup group={group(messages)} renderMessage={() => null} />);
    const toggle = screen.getByRole('button');
    expect(toggle).not.toHaveAttribute('aria-controls');
    fireEvent.click(toggle);
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getAllByTestId('trajectory-history-entry')).toHaveLength(5);
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
  it('does not invent elapsed time for a missing timestamp', () => {
    const untimed = { ...activity('read_file'), timestamp: '' };
    render(<TrajectoryWorkGroup group={group([untimed])} renderMessage={() => null} />);
    expect(screen.getByTestId('trajectory-batch-elapsed')).toHaveTextContent('Timing unavailable');
  });
});
