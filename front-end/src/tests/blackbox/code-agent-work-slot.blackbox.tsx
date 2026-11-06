/**
 * Blackbox: a running code-agent turn renders as the root transcript's running
 * work row (Andy 2026-10-26: "sometimes thoughts display like before, instead of
 * within the Working fold"): the code-agent view's MessageList folds the turn into
 * ONE running TrajectoryWorkGroup showing its latest activity and elapsed time; the
 * thoughts and steps appear only when the row is expanded.
 */
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { CodeAgentConversationView } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentConversationView';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';

import { ROOT_AGENT_ID, WithAgent, eventsMessage, signIn } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';

const { fetchSession } = vi.hoisted(() => ({ fetchSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/terminal-component-group/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/terminal-component-group/api')>()),
  fetchCodeAgentSession: fetchSession,
}));

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
});

const RUNNING_WITH_THOUGHT = [
  {
    id: 'goal',
    seq: 0,
    type: 'message',
    role: 'user',
    sender: 'agent',
    text: 'Chart BTC',
    ts: 1000,
  },
  { id: 'start', seq: 1, type: 'turn', event: 'started', turn_id: 'one', ts: 1100 },
  {
    id: 'edit',
    seq: 2,
    type: 'tool',
    turn_id: 'one',
    ts: 1200,
    tool: { name: 'Edit', target: 'chart.py' },
  },
  {
    id: 'th',
    seq: 3,
    type: 'thinking',
    turn_id: 'one',
    ts: 1300,
    text: 'Plotting the hourly closes next.',
  },
];

/** The live code-agent view of task-1 (read-only: no query box) over these rows. */
function liveView(messages: Message[]) {
  return createElement(
    WithAgent,
    { messages },
    createElement(CodeAgentConversationView, {
      codeAgent: {
        taskId: 'task-1',
        ownerAgentId: ROOT_AGENT_ID,
        provider: 'codex',
        title: 'Chart BTC',
        status: 'ACTIVE',
      },
      readOnlyMessage: 'read only',
    }),
  );
}

function renderSession(records: unknown[], untimed = false) {
  const carrier = eventsMessage(records);
  // An untimed carrier row and records without ts: the turn's start is unknown.
  if (untimed) carrier.timestamp = '';
  return liveView([carrier]);
}

const workRows = () => screen.queryAllByTestId('trajectory-work-group');

describe('code-agent running work row', () => {
  it('an unknown start shows the latest activity and no invented clock', () => {
    signIn();
    const view = renderWithProviders(
      renderSession(
        [{ id: 'edit', seq: 1, type: 'tool', tool: { name: 'Edit', target: 'chart.py' } }],
        true,
      ),
      { roseDesktop: true },
    );
    expect(workRows()).toHaveLength(1);
    const [row] = workRows();
    expect(row).toHaveAttribute('data-state', 'running');
    const fold = within(row).getAllByRole('button')[0];
    expect(within(fold).getByTestId('trajectory-activity-line')).toHaveTextContent('Edit chart.py');
    // The root work row's own rule: an unknown start reads "Timing unavailable",
    // never an invented duration.
    expect(within(fold).getByTestId('trajectory-batch-elapsed')).toHaveTextContent(
      'Timing unavailable',
    );
    expect(fold).not.toHaveTextContent(/\d+(\.\d)?s\b/);
    view.rerender(
      renderSession([{ id: 'th', seq: 1, type: 'thinking', partial: true, ts: 1000, text: 'Hmm' }]),
    );
    // A streaming thought is the latest activity of the same running row.
    expect(workRows()).toHaveLength(1);
    expect(workRows()[0]).toHaveAttribute('data-state', 'running');
    expect(workRows()[0].getAttribute('data-activity-kinds')).toContain('thinking');
    expect(screen.getAllByTestId('trajectory-batch-elapsed')).toHaveLength(1);
  });

  it('a turn id arriving later keeps the same work row (expand state survives)', () => {
    signIn();
    const before = [
      { id: 'goal', seq: 0, type: 'message', role: 'user', sender: 'agent', text: 'Go', ts: 1000 },
      { id: 'edit', seq: 1, type: 'tool', ts: 1200, tool: { name: 'Edit', target: 'chart.py' } },
    ];
    const view = renderWithProviders(renderSession(before), { roseDesktop: true });
    const [row] = workRows();
    const fold = within(row).getAllByRole('button')[0];
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    view.rerender(
      renderSession([
        ...before,
        { id: 'start', seq: 2, type: 'turn', event: 'started', turn_id: 'native-1', ts: 1300 },
      ]),
    );
    expect(workRows()).toHaveLength(1);
    expect(workRows()[0]).toBe(row);
    expect(within(row).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByTestId('trajectory-work-history')).toHaveTextContent('chart.py');
  });

  it('a running turn whose latest activity is a thought renders no standalone Thought card', () => {
    signIn();
    renderWithProviders(liveView([eventsMessage(RUNNING_WITH_THOUGHT)]), { roseDesktop: true });
    const page = screen.getByTestId('code-agent-view');
    const rows = workRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toHaveAttribute('data-state', 'running');
    const fold = within(row).getAllByRole('button')[0];
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).getByTestId('trajectory-batch-elapsed')).toBeInTheDocument();
    expect(document.querySelector('[data-tool-name="thought"]')).toBeNull();
    expect(page.querySelector('[data-message-id]:not([data-message-role="USER"])')).toBeNull();
    expect(screen.queryByText('Plotting the hourly closes next.')).toBeNull();

    fireEvent.click(fold);
    const history = within(row).getByTestId('trajectory-work-history');
    expect(history.querySelector('[data-tool-name="thought"]')).not.toBeNull();
    expect(history.querySelector('[data-tool-name="Edit"]')).not.toBeNull();
  });
});
