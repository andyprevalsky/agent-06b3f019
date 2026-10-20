/**
 * Blackbox: agent-to-agent rows and the code-agent wire adapter (Rose Desktop,
 * UI ledger rows 12 + 47b, contract from backend agentGraphSendService). Flag
 * on renders "Codex → Rose" rows in the code agent's transcript and the
 * trajectory (never user bubbles); flag off keeps the stock rendering.
 * Malformed metadata always falls back to the stock UI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { PinnedQuestionMount } from '@/features/terminal-component-group/components/PinnedQuestion';
import { filterMessagesForSubAgent } from '@/features/terminal-component-group/components/useMessageFiltering';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import {
  collectCodeAgentEvents,
  parseAgentToAgentMessage,
  parseCodeAgentMeta,
  parsePinnedQuestion,
} from '@/features/terminal-component-group/hooks/codeAgentContract';

import {
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
    expect(parseCodeAgentMeta(codeAgent({ state: 'paused' }))).toBeNull();
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
