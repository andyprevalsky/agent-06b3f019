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
import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { ToolMessage } from '@/features/terminal-component-group/components/message-bubble/ToolMessage';
import { useToolData } from '@/features/terminal-component-group/components/message-bubble/useToolData';
import type { Message } from '@/lib/api';
import { msg } from './code-agent-steering.fixtures';

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
