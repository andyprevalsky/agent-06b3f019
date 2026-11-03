import { describe, expect, it } from 'vitest';
import {
  buildCodeSession,
  workLabel,
} from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { dedupeCodeDisplays } from '@/features/terminal-component-group/hooks/codeDisplayIdentity';
import { eventsMessage, msg } from './code-agent-steering.fixtures';

const at = (s: number) => `2026-10-20T12:00:${String(s).padStart(2, '0')}.000Z`;
const build = (records: unknown[], extra = {}) =>
  buildCodeSession({
    messages: [eventsMessage(records)],
    taskId: 'task-1',
    ownerAgentId: 'root',
    provider: 'codex',
    sessionState: 'running',
    sessionEndedAt: null,
    echoes: [],
    ...extra,
  });
const turn = (event: string, id = 'native-1', second = 0) => ({
  id: `${id}-${event}`,
  type: 'turn',
  event,
  turn_id: id,
  ts: at(second),
  turn_started_at: at(0),
  ...(event === 'ended' ? { turn_ended_at: at(second), turn_outcome: 'completed' } : {}),
});

describe('a delivered Rose message is matched within its own session', () => {
  it("another session's a2a row with the same code_turn_id never replaces this session's", () => {
    const row = (taskId: string, text: string) =>
      msg(
        {
          action_type: 'agent_message',
          task_id: taskId,
          subAgentId: taskId,
          code_turn_id: 'a2a-shared',
          a2a: {
            kind: 'message',
            message_id: 'm-1',
            direction: 'received',
            text,
            from: { id: 'root', kind: 'agent', label: 'Rose' },
            to: { id: taskId, kind: 'code', label: 'Codex' },
          },
        },
        { text },
      );
    const entries = buildCodeSession({
      messages: [
        eventsMessage([
          {
            id: 'goal',
            seq: 0,
            type: 'message',
            role: 'user',
            sender: 'agent',
            text: 'Go',
            ts: at(1),
          },
          {
            id: 'turn:a2a-shared',
            seq: 1,
            type: 'message',
            role: 'user',
            sender: 'agent',
            client_message_id: 'a2a-shared',
            text: '[Message from Rose …]\n\nFor task one',
            ts: at(3),
          },
        ]),
        row('task-1', 'For task one'),
        // Same sender + message_id to another session → the same code_turn_id.
        row('task-2', 'For task two'),
      ],
      taskId: 'task-1',
      ownerAgentId: 'root',
      provider: 'codex',
      sessionState: 'running',
      sessionEndedAt: null,
      echoes: [],
    });
    const texts = JSON.stringify(entries);
    expect(texts).toContain('For task one');
    expect(texts).not.toContain('For task two');
  });
});

describe('native code-session work slots', () => {
  it.each(['claude', 'codex'] as const)(
    'folds %s streaming/replay and keeps final answer outside the work slot',
    (provider) => {
      const records = [
        turn('started'),
        {
          id: 'tool',
          rev: 1,
          seq: 1,
          type: 'tool',
          turn_id: 'native-1',
          ts: at(1),
          tool: {
            name: 'Read',
            target: 'a.ts',
            activity_kind: 'read',
            result: { status: 'running' },
          },
        },
        {
          id: 'tool',
          rev: 2,
          seq: 1,
          type: 'tool',
          turn_id: 'native-1',
          ts: at(2),
          tool: { name: 'Read', target: 'a.ts', activity_kind: 'read', result: { status: 'ok' } },
        },
        { id: 'answer', type: 'message', ts: at(3), turn_id: 'native-1', text: 'Done.' },
        turn('ended', 'native-1', 5),
      ];
      const entries = build(records.concat(records), { provider });
      const slots = entries.filter((e) => e.kind === 'work');
      expect(slots).toHaveLength(1);
      if (slots[0].kind !== 'work') throw Error('missing slot');
      expect(slots[0].turn.activities).toHaveLength(1);
      expect(slots[0].turn.summary).toBe('Explored 1 file');
      expect(workLabel(slots[0].turn)).toBe('Worked for 5.0s');
      expect(
        entries
          .filter((e) => e.kind === 'message')
          .map((e) => e.kind === 'message' && e.message.text),
      ).toEqual(['Done.']);
    },
  );

  it('keeps repeated user steers distinct and within the same native work slot', () => {
    const records = [
      turn('started'),
      { id: 'work', type: 'thinking', text: 'Working', ts: at(1), turn_id: 'native-1' },
    ];
    const messages = [
      eventsMessage(records),
      ...['a', 'b'].map((id, i) =>
        msg(
          { task_id: 'task-1', action_type: 'user_direct_turn', direct_turn_id: id },
          { text: 'continue', timestamp: at(i + 2) },
        ),
      ),
    ];
    const entries = build([], {
      messages,
      echoes: [{ id: 'a', text: 'continue', at: Date.parse(at(2)) }],
    });
    expect(entries.filter((e) => e.kind === 'work')).toHaveLength(1);
    expect(entries.filter((e) => e.kind === 'message')).toHaveLength(2);
  });

  it('keeps native turns separate and shows interrupted/failed lifecycle truthfully', () => {
    const entries = build([
      turn('started'),
      { id: 'a', type: 'thinking', text: 'first', turn_id: 'native-1', ts: at(1) },
      { ...turn('ended', 'native-1', 4), turn_outcome: 'interrupted' },
      turn('started', 'native-2', 5),
      { id: 'b', type: 'thinking', text: 'second', turn_id: 'native-2', ts: at(6) },
      { ...turn('ended', 'native-2', 8), turn_started_at: at(5), turn_outcome: 'failed' },
    ]);
    expect(
      entries.filter((e) => e.kind === 'work').map((e) => e.kind === 'work' && workLabel(e.turn)),
    ).toEqual(['Interrupted after 4.0s', 'Failed after 3.0s']);
  });
});

it('deduplicates canonical displays after conversation filtering and prefers the parent mirror', () => {
  const own = msg({ display: { canonical_id: 'display-one', conversation: 'own' } });
  const parent = msg({ display: { canonical_id: 'display-one', conversation: 'parent' } });
  expect(dedupeCodeDisplays([own, parent, parent])).toEqual([parent]);
  expect(dedupeCodeDisplays([own, parent])).toEqual([parent]);
  expect(dedupeCodeDisplays([own])).toEqual([own]);
});

it('resets measured session rates at native turn boundaries and counter resets', () => {
  const metrics = (id: string, turnId: string, second: number, output: number) => ({
    id,
    type: 'metrics',
    turn_id: turnId,
    ts: at(second),
    output_tokens: output,
    usage_scope: 'session',
  });
  const entries = build([
    turn('started'),
    metrics('m1', 'native-1', 1, 1000),
    metrics('m2', 'native-1', 3, 1040),
    turn('ended', 'native-1', 4),
    turn('started', 'native-2', 5),
    metrics('m3', 'native-2', 6, 1100),
    metrics('m4', 'native-2', 7, 10),
  ]);
  const slots = entries.filter((entry) => entry.kind === 'work');
  expect(slots[0].kind === 'work' && slots[0].turn.metrics).toMatchObject({
    outputTokens: 40,
    tokensPerSecond: 20,
  });
  expect(slots[1].kind === 'work' && slots[1].turn.metrics?.tokensPerSecond).toBeUndefined();
  expect(slots[1].kind === 'work' && slots[1].turn.metrics?.outputTokens).toBeUndefined();
});
