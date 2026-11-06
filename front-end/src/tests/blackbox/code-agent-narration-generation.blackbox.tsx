/**
 * Blackbox (final-run5 replay, item 4): mid-turn narration of a code agent renders as a
 * "Thought" row, so it carries the generation of the model call that wrote it like a
 * thinking row does. Before the fix those rows read a bare "Thought" beside rows with
 * "0.6s · 426 tokens · 744.8 tok/s", which looked broken.
 *
 * One Claude turn: usage sample (100 tokens @ t0) → narration → a tool created and
 * finished inside the call's window → usage sample (300 tokens @ t0 + 2 s).
 */
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { codeSessionMessages } from '@/features/terminal-component-group/hooks/codeSessionMessages';
import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { ToolMessage } from '@/features/terminal-component-group/components/message-bubble/ToolMessage';
import { useToolData } from '@/features/terminal-component-group/components/message-bubble/useToolData';
import type { Message } from '@/lib/api';
import { msg } from './code-agent-steering.fixtures';
import run5 from './code-agent-view-final-run5.fixture.json';

const TASK = 'task-narration';
const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

const records = [
  { id: 'goal', seq: 0, type: 'message', role: 'user', sender: 'agent', text: 'Go', ts: at(0) },
  {
    id: 'start',
    seq: 1,
    type: 'turn',
    event: 'started',
    turn_id: 't1',
    ts: at(10),
    turn_started_at: at(10),
  },
  {
    id: 'm1',
    seq: 2,
    type: 'metrics',
    turn_id: 't1',
    usage_scope: 'turn',
    output_tokens: 100,
    ts: at(100),
  },
  {
    id: 'narr',
    seq: 3,
    type: 'message',
    turn_id: 't1',
    text: 'Checking the repo first.',
    ts: at(900),
  },
  {
    id: 'tool',
    seq: 4,
    rev: 2,
    type: 'tool',
    turn_id: 't1',
    ts: at(1500),
    tool: { name: 'Run', target: 'git status', result: { status: 'ok' } },
  },
  {
    id: 'm2',
    seq: 5,
    type: 'metrics',
    turn_id: 't1',
    usage_scope: 'turn',
    output_tokens: 300,
    ts: at(2100),
  },
];

function narration(): Message {
  const messages: Message[] = [
    msg(
      {
        toolName: 'spawn_claude_code_agent',
        task_id: TASK,
        subAgentId: TASK,
        action_type: 'code_transcript',
        hidden: true,
        code_agent_events: records,
      },
      { message_id: 'carrier', timestamp: at(0) },
    ),
  ];
  const row = buildCodeSession({
    messages,
    taskId: TASK,
    ownerAgentId: 'owner',
    provider: 'claude',
    sessionState: 'running',
    sessionEndedAt: null,
    echoes: [],
  })
    .flatMap((entry) => (entry.kind === 'work' ? entry.turn.activities : []))
    .find((message) => message.role === 'ASSISTANT');
  if (!row) throw new Error('no narration row');
  return row;
}

describe('a code agent narration row carries its call generation', () => {
  it('records the bracketing samples: 200 tokens over 2.0 s', () => {
    expect(narration().metadata?.generation).toEqual({
      output_tokens: 200,
      started_at: at(100),
      ended_at: at(2100),
    });
  });

  it('renders as a Thought row with duration, tokens and tok/s like a thinking row', () => {
    const message = narration();
    const view = render(
      createElement(function Row() {
        const data = useToolData({ message, isStreaming: false, isAssistant: true, isTool: false });
        return data ? createElement(ToolMessage, { data }) : null;
      }),
    );
    expect(view.container).toHaveTextContent('Thought');
    expect(view.container).toHaveTextContent('2.0s');
    expect(view.container).toHaveTextContent('200 tokens');
    expect(view.container).toHaveTextContent('100.0 tok/s');
  });
});

/**
 * One model call = ONE Thought row. A call's thinking record and its narration text both
 * carry the call's generation; rendered separately they read as a duplicated row
 * ("Thought 0.0s · 495 tokens" twice). The code view's list merges them: metrics once,
 * the expanded content holds the reasoning and the narration text.
 */
type Generation = { output_tokens?: number; started_at?: string; ended_at?: string };
const isThoughtRow = (m: Message) =>
  m.role === 'ASSISTANT' || (m.role === 'TOOL' && m.metadata?.toolName === 'thought');
const windowOf = (m: Message) => {
  const g = m.metadata?.generation as Generation | undefined;
  return g ? `${g.started_at}|${g.ended_at}|${g.output_tokens}` : null;
};

describe('one Thought row per model call (final-run5 replay)', () => {
  const TASK_5 = '7e45fb38-1729-4677-aa8e-fd9c7dfb37da';
  const rows = () =>
    codeSessionMessages({
      messages: run5.messages as unknown as Message[],
      taskId: TASK_5,
      ownerAgentId: run5.agent.agent_id,
      provider: 'claude',
      sessionState: 'paused',
      sessionEndedAt: null,
      echoes: [],
    });

  it('no two adjacent Thought rows share a generation window', () => {
    const list = rows();
    for (let i = 1; i < list.length; i += 1) {
      const a = windowOf(list[i - 1]);
      if (a && isThoughtRow(list[i - 1]) && isThoughtRow(list[i])) {
        expect(windowOf(list[i]), `rows ${i - 1} and ${i} are one call`).not.toBe(a);
      }
    }
  });

  it('the call that had redacted thinking AND its reasoning text is one row carrying both', () => {
    const merged = rows().filter((m) =>
      m.text.includes('I sent the sleep and the git count-objects'),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].metadata?.toolName).toBe('thought');
    expect(windowOf(merged[0])).not.toBeNull();
  });

  it('every call keeps its metrics: each Thought row that had a generation still has one', () => {
    const withGeneration = rows().filter((m) => isThoughtRow(m) && windowOf(m) !== null);
    expect(withGeneration.length).toBeGreaterThanOrEqual(10);
  });
});

describe('a call with thinking AND narration, or narration only', () => {
  const both = [
    { id: 'goal', seq: 0, type: 'message', role: 'user', sender: 'agent', text: 'Go', ts: at(0) },
    {
      id: 'start',
      seq: 1,
      type: 'turn',
      event: 'started',
      turn_id: 't1',
      ts: at(10),
      turn_started_at: at(10),
    },
    {
      id: 'm1',
      seq: 2,
      type: 'metrics',
      turn_id: 't1',
      usage_scope: 'turn',
      output_tokens: 100,
      ts: at(100),
    },
    {
      id: 'think',
      seq: 3,
      type: 'thinking',
      turn_id: 't1',
      text: 'Reasoning about the repo.',
      ts: at(500),
    },
    {
      id: 'narr',
      seq: 4,
      type: 'message',
      turn_id: 't1',
      text: 'Checking the repo first.',
      ts: at(900),
    },
    {
      id: 'm2',
      seq: 5,
      type: 'metrics',
      turn_id: 't1',
      usage_scope: 'turn',
      output_tokens: 300,
      ts: at(2100),
    },
    {
      id: 'm3',
      seq: 6,
      type: 'metrics',
      turn_id: 't1',
      usage_scope: 'turn',
      output_tokens: 310,
      ts: at(2200),
    },
    {
      id: 'narr2',
      seq: 7,
      type: 'message',
      turn_id: 't1',
      text: 'Only text this time.',
      ts: at(2600),
    },
    {
      id: 'm4',
      seq: 8,
      type: 'metrics',
      turn_id: 't1',
      usage_scope: 'turn',
      output_tokens: 400,
      ts: at(3300),
    },
  ];
  const list = codeSessionMessages({
    messages: [
      msg(
        {
          toolName: 'spawn_claude_code_agent',
          task_id: TASK,
          subAgentId: TASK,
          action_type: 'code_transcript',
          hidden: true,
          code_agent_events: both,
        },
        { message_id: 'carrier', timestamp: at(0) },
      ),
    ],
    taskId: TASK,
    ownerAgentId: 'owner',
    provider: 'claude',
    sessionState: 'running',
    sessionEndedAt: null,
    echoes: [],
  }).filter(isThoughtRow);

  it('renders ONE row for the call, with its metrics once and both texts in its content', () => {
    const call = list.filter((m) => windowOf(m) === windowOf(list[0]));
    expect(call).toHaveLength(1);
    expect(call[0].metadata?.generation).toEqual({
      output_tokens: 200,
      started_at: at(100),
      ended_at: at(2100),
    });
    expect(call[0].text).toContain('Reasoning about the repo.');
    expect(call[0].text).toContain('Checking the repo first.');
  });

  it("a call with only narration still gets one row carrying that call's metrics", () => {
    const only = list.find((m) => m.text.includes('Only text this time.'));
    expect(only).toBeDefined();
    expect(only?.metadata?.generation).toEqual({
      output_tokens: 90,
      started_at: at(2200),
      ended_at: at(3300),
    });
    expect(list).toHaveLength(2);
  });
});
