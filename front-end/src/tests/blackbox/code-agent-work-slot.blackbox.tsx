/**
 * Blackbox: a running code-agent turn renders as the root transcript's running
 * work row (Andy 2026-10-26: "sometimes thoughts display like before, instead of
 * within the Working fold"): a compact "Working" fold with its elapsed time; the
 * thoughts and steps appear only when the fold is expanded.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { CodeSessionMessages } from '@/features/terminal-component-group/components/code-agent-view/CodeSessionMessages';

import { WithAgent, eventsMessage, signIn } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';

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

function renderRunning() {
  signIn();
  return renderWithProviders(
    createElement(
      WithAgent,
      { messages: [eventsMessage(RUNNING_WITH_THOUGHT)] },
      createElement(CodeSessionMessages, {
        c: { provider: 'codex', chipState: 'live', meta: null } as unknown as Parameters<
          typeof CodeSessionMessages
        >[0]['c'],
        taskId: 'task-1',
        echoes: [],
      }),
    ),
  );
}

function renderSession(records: unknown[], untimed = false) {
  const carrier = eventsMessage(records);
  // An untimed carrier row and records without ts: the turn's start is unknown.
  if (untimed) carrier.timestamp = '';
  return createElement(
    WithAgent,
    { messages: [carrier] },
    createElement(CodeSessionMessages, {
      c: { provider: 'codex', chipState: 'live', meta: null } as unknown as Parameters<
        typeof CodeSessionMessages
      >[0]['c'],
      taskId: 'task-1',
      echoes: [],
    }),
  );
}

describe('code-agent running work slot', () => {
  it('an unknown start reads just "Working"; the indicator never repeats the clock', () => {
    signIn();
    const view = renderWithProviders(
      renderSession(
        [{ id: 'edit', seq: 1, type: 'tool', tool: { name: 'Edit', target: 'chart.py' } }],
        true,
      ),
    );
    const fold = within(screen.getByTestId('code-work-slot')).getByRole('button');
    expect(fold).not.toHaveTextContent('Timing unavailable');
    expect(screen.queryByTestId('code-work-elapsed')).toBeNull();
    view.rerender(
      renderSession([{ id: 'th', seq: 1, type: 'thinking', partial: true, ts: 1000, text: 'Hmm' }]),
    );
    expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    expect(screen.queryByTestId('code-work-elapsed')).toBeNull();
  });

  it('a turn id arriving later keeps the same slot (expand state survives)', () => {
    signIn();
    const before = [
      { id: 'goal', seq: 0, type: 'message', role: 'user', sender: 'agent', text: 'Go', ts: 1000 },
      { id: 'edit', seq: 1, type: 'tool', ts: 1200, tool: { name: 'Edit', target: 'chart.py' } },
    ];
    const view = renderWithProviders(renderSession(before));
    const slot = screen.getByTestId('code-work-slot');
    fireEvent.click(within(slot).getByRole('button', { name: /Working/ }));
    view.rerender(
      renderSession([
        ...before,
        { id: 'start', seq: 2, type: 'turn', event: 'started', turn_id: 'native-1', ts: 1300 },
      ]),
    );
    expect(screen.getByTestId('code-work-slot')).toBe(slot);
    expect(within(slot).getByRole('button', { name: /Working/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('a running turn whose latest activity is a thought renders no standalone Thought card', () => {
    renderRunning();
    const slot = screen.getByTestId('code-work-slot');
    expect(slot).toHaveAttribute('data-state', 'running');
    const fold = within(slot).getByRole('button', { name: /Working/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(within(slot).getByTestId('code-work-elapsed')).toBeInTheDocument();
    expect(document.querySelector('[data-tool-name="thought"]')).toBeNull();
    expect(document.querySelector('[data-message-id]:not([data-message-role="USER"])')).toBeNull();
    expect(screen.queryByText('Plotting the hourly closes next.')).toBeNull();

    fireEvent.click(fold);
    expect(slot.querySelector('[data-tool-name="thought"]')).not.toBeNull();
    expect(slot.querySelector('[data-tool-name="Edit"]')).not.toBeNull();
  });
});
