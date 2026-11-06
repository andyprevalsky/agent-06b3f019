/**
 * Blackbox (Andy 2026-11-06, C6): thinking is a normal tool row in the work
 * description for the root agent and for code agents, and its tok/s comes from
 * recorded output tokens over the recorded generation window.
 *
 *  1. Live root thinking: the running work row shows the stock activity icon +
 *     label + batch clock, never the animated "Thinking" blob, and never a token
 *     count estimated from streamed characters.
 *  2. A finished thought carries metadata.generation (the LLM call's recorded
 *     output tokens and its start/end): the header and the thought row show
 *     "<duration> · ↓ <tokens> tokens · <tok/s> tok/s" (StreamingMetric: the
 *     separators are spaced by margin, so textContent reads "2.4s·596 tokens·…").
 *     Without it, no tokens.
 *  3. Code agents (prod run 1a3d495c, Claude Code task 6f8f8f4d): the thinking
 *     record becomes the same thought row, with the generation window bracketed
 *     by the session's own usage samples (384 → 1201 output tokens over
 *     30.816s → 36.866s = 817 tokens over 6.05s, 135.0 tok/s).
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentContext } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { checkThinkingRows } from '@/features/terminal-component-group/benchmark/thinkingRowsCheck';
import type { Message } from '@/lib/api';
import { makeCtx } from './browser-agent-chip.fixtures';
import { msg } from './code-agent-steering.fixtures';
import prodRun from './code-agent-thinking-prod-1a3d495c.fixture.json';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => createElement('span', { 'data-testid': 'thinking-animation' }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const start = Date.UTC(2026, 10, 6, 4, 21, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const goal = msg(
  {},
  {
    message_id: 'goal',
    role: 'USER',
    text: 'Whats our rose repo looking like?',
    timestamp: iso(start),
  },
);

function liveTree(messages: Message[], streamingBubbles: Map<string, unknown>) {
  const ctx = {
    ...makeCtx(messages),
    agent: { id: 'root', status: 'ACTIVE', updated_at: iso(start) } as never,
    streamingBubbles: streamingBubbles as never,
  };
  return createElement(AgentContext.Provider, { value: ctx }, createElement(MessageList));
}

function rows(messages: Message[]) {
  return createElement(MessageListItems, {
    filteredMessages: messages,
    groupAgentMessages: true,
    compressWork: true,
    workStatus: 'ACTIVE',
    currentAnimatingId: null,
    onAnimationComplete: () => {},
    selectedAgentId: 'root',
    exploreStepMap: new Map(),
    waitForCheckMap: new Map(),
    streamingMetricsBySubAgentId: new Map(),
  });
}

function rowsTree(messages: Message[]) {
  return createElement(
    AgentContext.Provider,
    { value: { ...makeCtx(messages), selectedAgentId: 'root' } },
    rows(messages),
  );
}

function expand() {
  fireEvent.click(within(screen.getByTestId('trajectory-work-group')).getAllByRole('button')[0]);
  return screen.getByTestId('trajectory-work-history');
}

describe('root agent thinking is a normal tool row', () => {
  it('live thinking: stock icon + label + clock; no blob, no character-estimated tokens', () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 5_000);
    const bubble = {
      text: '',
      sequence: 1,
      done: false,
      startedAtMs: start + 1_000,
      charCount: 4_000,
    };
    renderWithProviders(liveTree([goal], new Map([['stream-1', bubble]])));
    act(() => vi.advanceTimersByTime(1_000));
    const group = screen.getByTestId('trajectory-work-group');
    const header = within(group).getAllByRole('button')[0];
    expect(within(header).getByTestId('trajectory-activity-icon')).toHaveClass('lucide-lightbulb');
    expect(within(header).getByTestId('trajectory-activity-line')).toHaveTextContent(/^Thinking$/);
    expect(within(header).getByTestId('trajectory-batch-elapsed')).toBeInTheDocument();
    expect(within(group).queryByTestId('thinking-indicator')).toBeNull();
    expect(within(group).queryByTestId('thinking-animation')).toBeNull();
    // 4,000 streamed characters are not 1,000 tokens.
    expect(group).not.toHaveTextContent(/tokens/);
    const history = expand();
    expect(within(history).queryByTestId('thinking-animation')).toBeNull();
    expect(history.querySelector('.lucide-lightbulb')).not.toBeNull();
    expect(history).toHaveTextContent('Thinking');
  });

  it('a finished thought shows its recorded duration, output tokens and tok/s', () => {
    const thought = msg(
      {
        generation: {
          output_tokens: 596,
          started_at: iso(start + 10_000),
          ended_at: iso(start + 12_400),
        },
      },
      {
        message_id: 'thought-1',
        role: 'ASSISTANT',
        text: 'Spawning a Claude Code agent in the repo.',
        timestamp: iso(start + 12_400),
      },
    );
    renderWithProviders(rowsTree([goal, thought]));
    const line = screen.getByTestId('trajectory-activity-line');
    expect(line).toHaveTextContent('Thinking');
    expect(line).toHaveTextContent('2.4s·596 tokens·248.3 tok/s');
    const history = expand();
    const row = history.querySelector('[data-message-id="thought-1"]') as HTMLElement;
    expect(row).toHaveTextContent('Thought');
    expect(row).toHaveTextContent('2.4s·596 tokens·248.3 tok/s');
    expect(row.querySelector('.lucide-lightbulb')).not.toBeNull();
  });

  it('never estimates tokens for a thought without a recorded generation', () => {
    const thought = msg(
      {},
      {
        message_id: 'thought-2',
        role: 'ASSISTANT',
        text: 'x'.repeat(400),
        timestamp: iso(start + 1_000),
      },
    );
    renderWithProviders(rowsTree([goal, thought]));
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent(/^Thinking$/);
    const history = expand();
    expect(history).not.toHaveTextContent(/tokens|tok\/s/);
    expect(history.querySelector('.lucide-lightbulb')).not.toBeNull();
  });
});

const TASK_ID = prodRun.task_id;

function prodCarriers(): Message[] {
  return prodRun.carriers.map((carrier) =>
    msg(
      {
        toolName: 'spawn_claude_code_agent',
        task_id: TASK_ID,
        subAgentId: TASK_ID,
        action_type: 'code_transcript',
        hidden: true,
        code_agent_events: carrier.events,
      },
      { message_id: carrier.message_id, timestamp: carrier.timestamp },
    ),
  );
}

function prodThought(): Message {
  const entries = buildCodeSession({
    messages: prodCarriers(),
    taskId: TASK_ID,
    ownerAgentId: 'root',
    provider: 'claude',
    sessionState: 'completed',
    sessionEndedAt: null,
    echoes: [],
  });
  const thoughts = entries.flatMap((entry) =>
    entry.kind === 'work'
      ? entry.turn.activities.filter((m) => m.metadata?.toolName === 'thought')
      : [],
  );
  expect(thoughts).toHaveLength(1);
  return thoughts[0];
}

describe('code agent thinking is the same tool row', () => {
  it('brackets the thinking record with the session usage samples (prod 1a3d495c)', () => {
    expect(prodThought().metadata?.generation).toEqual({
      output_tokens: 817,
      started_at: '2026-11-06T04:24:30.816Z',
      ended_at: '2026-11-06T04:24:36.866Z',
    });
  });

  it('renders through the shared thought row with duration, tokens and tok/s', () => {
    const thought = prodThought();
    renderWithProviders(rowsTree([goal, thought]));
    const history = expand();
    const row = history.querySelector(`[data-message-id="${thought.message_id}"]`) as HTMLElement;
    expect(row).toHaveTextContent('Thought');
    expect(row).toHaveTextContent('6.0s·817 tokens·135.0 tok/s');
    expect(row.querySelector('.lucide-lightbulb')).not.toBeNull();
    expect(within(history).queryByTestId('thinking-animation')).toBeNull();
  });
});

describe('benchmark check: thinking rows with recorded tok/s (root + code agents)', () => {
  const rootThought = (generation?: Record<string, unknown>) =>
    msg(generation ? { generation } : {}, {
      message_id: 'root-thought',
      role: 'ASSISTANT',
      text: 'Spawning a Claude Code agent in the repo.',
      timestamp: '2026-11-06T04:21:13.920Z',
    });
  const generation = {
    output_tokens: 597,
    started_at: '2026-11-06T04:21:06.500Z',
    ended_at: '2026-11-06T04:21:13.700Z',
  };

  it('passes a run whose root and code-agent thoughts carry recorded generations', () => {
    const report = checkThinkingRows([goal, rootThought(generation), ...prodCarriers()], 'root');
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.root.measured[0].tokensPerSecond).toBeCloseTo(82.92, 2);
    expect(report.codeAgents).toHaveLength(1);
    expect(report.codeAgents[0].measured[0]).toMatchObject({ outputTokens: 817, durationMs: 6050 });
  });

  it('fails a run whose thoughts carry no recorded generation', () => {
    const report = checkThinkingRows([goal, rootThought(), ...prodCarriers()], 'root');
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      'root: no thinking row carries a recorded generation (tok/s)',
    ]);
  });
});
