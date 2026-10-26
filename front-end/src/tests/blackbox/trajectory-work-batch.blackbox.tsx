import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrajectoryWorkGroup } from '@/features/terminal-component-group/components/TrajectoryWorkGroup';
import { groupTrajectoryWork } from '@/features/terminal-component-group/components/trajectoryWorkGroups';
import { msg } from './code-agent-steering.fixtures';
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
    expect(screen.getByTestId('tool-batch-progress-ring')).toBeInTheDocument();
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
