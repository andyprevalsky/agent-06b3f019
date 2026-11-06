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
import {
  BURST_REASON,
  MAX_STREAMING_TOKENS_PER_SECOND,
  thoughtGeneration,
} from '@/features/terminal-component-group/components/thoughtGeneration';
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

describe('benchmark check (C21): rows are checked when they exist, required only on evidence', () => {
  const second = (n: number) => new Date(Date.UTC(2026, 10, 6, 6, 0, 0) + n * 1000).toISOString();
  const generation = {
    output_tokens: 597,
    started_at: '2026-11-06T04:21:06.500Z',
    ended_at: '2026-11-06T04:21:13.700Z',
  };
  const rootRow = (id: string, metadata: Record<string, unknown>, sec = 1) =>
    msg(metadata, {
      message_id: id,
      role: 'ASSISTANT',
      text: `Reasoning ${id}.`,
      timestamp: second(sec),
    });
  const runAgentRow = (id: string, withGeneration: boolean) =>
    rootRow(id, {
      tool_calls: [{ tool: 'web_search', tool_call_id: `${id}-call` }],
      ...(withGeneration ? { generation } : {}),
    });
  const carrier = (taskId: string, records: unknown[]) =>
    msg({
      toolName: 'spawn_claude_code_agent',
      task_id: taskId,
      subAgentId: taskId,
      action_type: 'code_transcript',
      hidden: true,
      code_agent_events: records,
    });
  const start = {
    id: 'start',
    seq: 0,
    type: 'turn',
    event: 'started',
    turn_id: 'native-1',
    ts: second(0),
    turn_started_at: second(0),
  };
  const usage = (id: string, seq: number, sec: number, output: number, scope = 'turn') => ({
    id,
    seq,
    type: 'metrics',
    ts: second(sec),
    output_tokens: output,
    usage_scope: scope,
  });
  const thinking = (id: string, seq: number, sec: number) => ({
    id,
    seq,
    type: 'thinking',
    text: `thinking ${id}`,
    ts: second(sec),
  });
  const tool = (id: string, seq: number, sec: number) => ({
    id,
    seq,
    type: 'tool',
    ts: second(sec),
    tool: { name: 'Bash', target: 'git status', result: { status: 'ok', exit_code: 0 } },
  });
  // Claude Code: a model call's thinking sits between its start and end usage samples.
  const measuredAgent = [
    start,
    usage('u1', 1, 1, 10),
    thinking('th', 2, 2),
    usage('u2', 3, 4, 410),
  ];
  const run = (rows: Message[], evidence?: Record<string, { reasoningTokens?: number }>) =>
    checkThinkingRows([goal, ...rows], 'root', { evidence });

  describe('(a) every thinking row that exists is verified', () => {
    it('passes measured root and code-agent rows, each rendered as a normal tool row', () => {
      const report = run([runAgentRow('r1', true), carrier('T', measuredAgent)]);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.root.verdict).toBe('checked');
      expect(report.root.measured[0].tokensPerSecond).toBeCloseTo(82.92, 2);
      expect(report.codeAgents[0]).toMatchObject({ taskId: 'T', verdict: 'checked' });
      expect(report.codeAgents[0].measured[0]).toMatchObject({
        outputTokens: 400,
        durationMs: 3000,
      });
      expect(report.detail).toEqual([
        'root: 1 thinking row, 1 measured (83–83 tok/s)',
        'code agent T: 1 thinking row, 1 measured (133–133 tok/s)',
      ]);
    });

    it('the prod run 1a3d495c passes (817 tokens / 6.05 s on the code agent)', () => {
      const report = run([runAgentRow('r1', true), ...prodCarriers()]);
      expect(report.failures).toEqual([]);
      expect(report.codeAgents[0].measured[0]).toMatchObject({
        outputTokens: 817,
        durationMs: 6050,
      });
    });

    it('reports, never fails, a root burst: a response that arrived in one flush has no rate', () => {
      const burst = { ...generation, ended_at: '2026-11-06T04:21:06.550Z' }; // 597 tokens in 50 ms
      const report = run([
        rootRow('r1', { tool_calls: [], generation: burst }),
        carrier('T', measuredAgent),
      ]);
      expect(report.failures).toEqual([]);
      expect(report.root.verdict).toBe('checked');
      expect(report.root.unmeasured).toEqual([
        { messageId: 'r1', reason: BURST_REASON, failing: false },
      ]);
      expect(report.notes).toContain(`root: thought r1 not measurable (${BURST_REASON})`);
    });

    it('still fails an out-of-range rate that is NOT a flagged burst (the bounds stay)', () => {
      const rows = [runAgentRow('r1', true), carrier('T', measuredAgent)];
      // 82.9 tok/s against a caller's tighter ceiling, and a 0.5 tok/s crawl below the floor.
      expect(
        checkThinkingRows([goal, ...rows], 'root', { maxTokensPerSecond: 50 }).failures[0],
      ).toContain('root: thought r1 runs at 82.9 tok/s (597 tokens / 7.20s), outside 1–50');
      const slow = { output_tokens: 5, started_at: second(0), ended_at: second(10) };
      expect(
        run([rootRow('slow', { tool_calls: [], generation: slow }), carrier('T', measuredAgent)])
          .failures[0],
      ).toContain('root: thought slow runs at 0.5 tok/s');
    });

    it('fails when the root run-agent loop wrote thinking rows and none carries a generation', () => {
      const report = run([runAgentRow('r1', false), carrier('T', measuredAgent)]);
      expect(report.failures).toEqual([
        'root: 1 run-agent thinking row, none carries a recorded generation (tok/s)',
      ]);
      expect(report.root.verdict).toBe('failed');
    });

    it('reports, never fails, root rows whose producer records no per-call usage', () => {
      const router = rootRow('router', { streamId: 'stream-1' });
      const dag = rootRow('dag', { dagTaskIndex: 0, streamId: 'dag-0' });
      const report = run([router, dag, runAgentRow('r1', true), carrier('T', measuredAgent)]);
      expect(report.failures).toEqual([]);
      expect(report.root.unmeasured.map((row) => row.messageId)).toEqual(['router', 'dag']);
      expect(report.notes).toEqual([
        'root: thought router not measurable (chat router/generator row: its producer records no per-call usage)',
        'root: thought dag not measurable (DAG reasoning row: its producer records no per-call usage)',
      ]);
    });

    it("never counts a sub-agent's text rows as the root's thinking", () => {
      const browserText = rootRow('browser-text', { subAgentId: 'browser-1' });
      const report = run([browserText, carrier('T', measuredAgent)]);
      expect(report.root.thoughts).toBe(0);
      expect(report.root.verdict).toBe('n/a');
    });

    it('reports, never fails, a thought no usage sample precedes (nothing can bracket it)', () => {
      const report = run([
        carrier('T', [
          start,
          thinking('th', 1, 0.5),
          usage('u1', 2, 1, 10),
          usage('u2', 3, 4, 410),
        ]),
      ]);
      expect(report.failures).toEqual([]);
      expect(report.notes).toEqual([
        'no thinking recorded for root (N/A)',
        'code agent T: thought code:T:th not measurable (no usage sample precedes it)',
      ]);
      expect(report.codeAgents[0].unmeasured[0]).toMatchObject({ failing: false });
    });

    it('reports, never fails, a thought cut off before its call finished (no sample follows)', () => {
      const report = run([carrier('T', [start, usage('u1', 1, 1, 10), thinking('th', 2, 2)])]);
      expect(report.failures).toEqual([]);
      expect(report.notes).toEqual([
        'no thinking recorded for root (N/A)',
        'code agent T: thought code:T:th not measurable (no usage sample follows it (the session ended or was interrupted before the call finished))',
      ]);
    });

    it("does not call a call's own streaming tool a tool run: a tool created inside the window is fine", () => {
      // The tool is created (seq 3) after the window's first sample (seq 1) and finishes before the last.
      const streaming = [
        start,
        usage('u1', 1, 1, 10),
        thinking('th', 2, 2),
        tool('run', 3, 3),
        usage('u2', 4, 4, 410),
      ];
      const report = run([carrier('T', streaming)]);
      expect(report.failures).toEqual([]);
      expect(report.codeAgents[0].measured[0]).toMatchObject({ outputTokens: 400 });
    });

    it('reports, never fails, a window a tool created before it finished inside', () => {
      const spanning = [
        start,
        tool('run', 1, 2), // created before u1, finishes inside the window
        usage('u1', 2, 1, 10),
        thinking('th', 3, 2.5),
        usage('u2', 4, 4, 410),
      ];
      const report = run([carrier('T', spanning)]);
      expect(report.failures).toEqual([]);
      expect(report.notes).toEqual([
        'no thinking recorded for root (N/A)',
        'code agent T: thought code:T:th not measurable (a tool created before the window finished inside it)',
      ]);
    });

    it('fails a code agent that has thinking rows and no usage samples at all', () => {
      const report = run([carrier('T', [start, thinking('th', 1, 1)])]);
      expect(report.failures).toEqual([
        'code agent T: thought code:T:th carries no recorded generation (no usage samples recorded for this session)',
      ]);
    });

    it('reports, never fails, a Codex thought whose session-scoped window spans a tool run', () => {
      const codex = [
        start,
        tool('run', 1, 2), // created during the response that ends at s1, finished after it
        usage('s1', 2, 1, 1000, 'session'),
        thinking('th', 3, 2.5),
        usage('s2', 4, 3, 1100, 'session'),
      ];
      const report = run([carrier('T', codex)]);
      expect(report.failures).toEqual([]);
      expect(report.codeAgents[0]).toMatchObject({ verdict: 'checked' });
      expect(report.codeAgents[0].unmeasured).toEqual([
        {
          messageId: 'code:T:th',
          reason: 'a tool created before the window finished inside it',
          failing: false,
        },
      ]);
    });

    it('fails a run with no code agent', () => {
      expect(run([runAgentRow('r1', true)]).failures).toEqual([
        'no code-agent transcript in the run',
      ]);
    });
  });

  describe('(b) thinking rows are required only on evidence of thinking', () => {
    it('fails a root whose recorded usage shows reasoning tokens but that shows no thinking row', () => {
      const report = run([carrier('T', measuredAgent)], { root: { reasoningTokens: 120 } });
      expect(report.failures).toEqual([
        'root: thinking recorded (120 reasoning tokens in recorded usage) but no thinking row is shown',
      ]);
      expect(report.root.verdict).toBe('failed');
    });

    it('fails a code agent with reasoning-token evidence and no thinking row', () => {
      const quiet = [start, tool('run', 1, 1)];
      const report = run([runAgentRow('r1', true), carrier('T', quiet)], {
        T: { reasoningTokens: 50 },
      });
      expect(report.failures).toEqual([
        'code agent T: thinking recorded (50 reasoning tokens in recorded usage) but no thinking row is shown',
      ]);
    });

    it('holds an agent that has the evidence AND the rows to the row checks, not to N/A', () => {
      const report = run([runAgentRow('r1', true), carrier('T', measuredAgent)], {
        root: { reasoningTokens: 120 },
        T: { reasoningTokens: 400 },
      });
      expect(report.failures).toEqual([]);
      expect(report.root.verdict).toBe('checked');
    });
  });

  describe('(c) no evidence and no rows is an explicit N/A, never a failure', () => {
    it('labels the root and a code agent that recorded no thinking', () => {
      const quiet = [start, tool('run', 1, 1)];
      const report = run([carrier('T', quiet)]);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.root.verdict).toBe('n/a');
      expect(report.codeAgents[0].verdict).toBe('n/a');
      expect(report.notes).toEqual([
        'no thinking recorded for root (N/A)',
        'no thinking recorded for code agent T (N/A)',
      ]);
      expect(report.detail).toEqual([
        'root: N/A, no thinking recorded',
        'code agent T: N/A, no thinking recorded',
      ]);
    });
  });
});

describe('Codex session-scoped counters bracket a thought only over generation', () => {
  const second = (n: number) => new Date(Date.UTC(2026, 10, 6, 4, 30, 0) + n * 1000).toISOString();
  const usage = (id: string, seq: number, sec: number, output: number) => ({
    id,
    seq,
    type: 'metrics',
    ts: second(sec),
    output_tokens: output,
    usage_scope: 'session',
  });
  const thought = (id: string, seq: number, sec: number) => ({
    id,
    seq,
    type: 'thinking',
    text: `thinking ${id}`,
    ts: second(sec),
  });
  const generations = () => {
    const records = [
      {
        id: 'start',
        seq: 0,
        type: 'turn',
        event: 'started',
        turn_id: 'native-1',
        ts: second(0),
        turn_started_at: second(0),
      },
      thought('before-any-sample', 1, 0.5), // no earlier sample: no baseline to bracket from
      usage('u1', 2, 1, 1000), // a resumed session: its first sample is not "tokens since 0"
      thought('clean-window', 3, 2.5),
      {
        // Created while the response that ends at u2 streamed (Codex runs a response's
        // tools after it completes); it finishes after u2, inside the next window.
        id: 'run',
        seq: 4,
        type: 'tool',
        ts: second(4),
        tool: { name: 'Bash', target: 'git status', result: { status: 'ok', exit_code: 0 } },
      },
      usage('u2', 5, 3, 1100), // (1s, 3s]: 100 tokens in 2s, no tool finished inside
      thought('window-with-a-tool', 6, 4.5),
      usage('u3', 7, 6, 1200), // (3s, 6s]: a tool created before it finished inside: not generation
    ];
    const entries = buildCodeSession({
      messages: [
        msg({
          toolName: 'spawn_claude_code_agent',
          task_id: 'task-1',
          subAgentId: 'task-1',
          action_type: 'code_transcript',
          hidden: true,
          code_agent_events: records,
        }),
      ],
      taskId: 'task-1',
      ownerAgentId: 'root',
      provider: 'codex',
      sessionState: 'completed',
      sessionEndedAt: null,
      echoes: [],
    });
    return Object.fromEntries(
      entries
        .flatMap((entry) => (entry.kind === 'work' ? entry.turn.activities : []))
        .filter((message) => message.metadata?.toolName === 'thought')
        .map((message) => [message.text.replace('thinking ', ''), message.metadata?.generation]),
    );
  };

  it('records a window only when it holds generation, never an invented or cross-tool rate', () => {
    expect(generations()).toEqual({
      'before-any-sample': undefined,
      'clean-window': {
        output_tokens: 100,
        started_at: second(1),
        ended_at: second(3),
      },
      'window-with-a-tool': undefined,
    });
  });
});

describe('an unfinalized thought never outlives its turn', () => {
  const second = (n: number) => new Date(Date.UTC(2026, 10, 6, 5, 0, 0) + n * 1000).toISOString();
  const rows = (records: unknown[], sessionState: 'running' | 'paused') =>
    buildCodeSession({
      messages: [
        msg({
          toolName: 'spawn_claude_code_agent',
          task_id: 'task-1',
          subAgentId: 'task-1',
          action_type: 'code_transcript',
          hidden: true,
          code_agent_events: records,
        }),
      ],
      taskId: 'task-1',
      ownerAgentId: 'root',
      provider: 'claude',
      sessionState,
      sessionEndedAt: sessionState === 'paused' ? Date.parse(second(9)) : null,
      echoes: [],
    })
      .flatMap((entry) => (entry.kind === 'work' ? entry.turn.activities : []))
      .filter((message) => message.metadata?.toolName === 'thought')
      .map((message) => [message.metadata?.toolStatus, message.metadata?.title]);
  const started = {
    id: 'start',
    seq: 0,
    type: 'turn',
    event: 'started',
    turn_id: 'native-1',
    ts: second(0),
    turn_started_at: second(0),
  };
  const streaming = {
    id: 'th',
    seq: 1,
    type: 'thinking',
    partial: true,
    text: 'Hmm',
    ts: second(1),
  };

  it('is a live "Thinking" row while its turn runs, then a finished "Thought"', () => {
    expect(rows([started, streaming], 'running')).toEqual([['IN_PROGRESS', 'Thinking']]);
    const ended = {
      id: 'end',
      seq: 2,
      type: 'turn',
      event: 'ended',
      turn_id: 'native-1',
      ts: second(5),
      turn_ended_at: second(5),
      turn_outcome: 'interrupted',
    };
    expect(rows([started, streaming, ended], 'running')).toEqual([['FINISHED', 'Thought']]);
  });

  it('settles when the session closes with the turn still open', () => {
    expect(rows([started, streaming], 'paused')).toEqual([['FINISHED', 'Thought']]);
  });
});

describe('thoughtGeneration: the one judge of what a recorded generation can show', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 6, 7, 0, 0) + ms).toISOString();
  const recorded = (tokens: number, ms: number) => ({
    generation: { output_tokens: tokens, started_at: at(0), ended_at: at(ms) },
  });

  it('exports the streaming bound once, for the row and the benchmark check alike', () => {
    expect(MAX_STREAMING_TOKENS_PER_SECOND).toBe(5_000);
  });

  it('keeps the rate of a streamed response (an old-shape row renders unchanged)', () => {
    expect(thoughtGeneration(recorded(817, 6050))).toEqual({
      outputTokens: 817,
      durationMs: 6050,
      tokensPerSecond: 817 / 6.05,
    });
  });

  it('a rate at the bound is measured; above it the response was not streamed', () => {
    expect(thoughtGeneration(recorded(5_000, 1_000))?.tokensPerSecond).toBe(5_000);
    expect(thoughtGeneration(recorded(5_001, 1_000))).toEqual({
      outputTokens: 5_001,
      durationMs: 1_000,
      tokensPerSecond: null,
      notMeasurable: BURST_REASON,
    });
  });

  it('records no generation without a positive duration or any tokens', () => {
    expect(thoughtGeneration(recorded(463, 0))).toBeNull();
    expect(thoughtGeneration(recorded(0, 1_000))).toBeNull();
    expect(thoughtGeneration({})).toBeNull();
  });
});
