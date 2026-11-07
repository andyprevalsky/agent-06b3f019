/**
 * Blackbox (C22): the benchmark check still FAILS when the projection drops a recordable
 * generation. The projection is stubbed to strip every `generation` from its thought rows
 * (a regression of exactly the kind C22 fixed); the check's own oracle, which reads the raw
 * records, must call each of those rows recordable and fail it. Without this, a green
 * check on the integrated runs could just mean the check cannot fail.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkThinkingRows } from '@/features/terminal-component-group/benchmark/thinkingRowsCheck';
import type { Message } from '@/lib/api';
import { msg } from './code-agent-steering.fixtures';
import fixture from './code-agent-streaming-runs.fixture.json';

vi.mock('@/features/terminal-component-group/hooks/codeSessionTurns', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/features/terminal-component-group/hooks/codeSessionTurns')
    >();
  return {
    ...actual,
    buildCodeSession: (input: Parameters<typeof actual.buildCodeSession>[0]) =>
      actual.buildCodeSession(input).map((entry) =>
        entry.kind === 'work'
          ? {
              ...entry,
              turn: {
                ...entry.turn,
                activities: entry.turn.activities.map((message) => {
                  const { generation: _dropped, ...rest } = message.metadata ?? {};
                  return message.metadata?.toolName === 'thought'
                    ? { ...message, metadata: rest }
                    : message;
                }),
              },
            }
          : entry,
      ),
  };
});

type Carrier = { message_id: string; timestamp: string; events: unknown[] };
const run = fixture.runs.be1c90da as { agent_id: string; tasks: Record<string, Carrier[]> };

describe('the benchmark check fails a projection that loses recordable generations', () => {
  it('fails every thought of run be1c90da as recordable but not recorded', () => {
    const messages: Message[] = Object.entries(run.tasks).flatMap(([taskId, carriers]) =>
      carriers.map((carrier) =>
        msg(
          {
            toolName: 'spawn_claude_code_agent',
            task_id: taskId,
            subAgentId: taskId,
            action_type: 'code_transcript',
            hidden: true,
            code_agent_events: carrier.events,
          },
          { message_id: carrier.message_id, timestamp: carrier.timestamp },
        ),
      ),
    );
    const report = checkThinkingRows(messages, run.agent_id);
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(13); // 9 + 4 thinking rows, all recordable
    expect(report.failures[0]).toMatch(
      /^code agent 24f6a6ab-eaa0-49c6-84ee-47064216b05b: thought code:24f6a6ab-eaa0-49c6-84ee-47064216b05b:item:msg_011CgmFE28ivM8MQCWDUFoFw:0 carries no recorded generation \(recordable: usage samples seq 7 to 15 bracket it \(215 tokens, no tool running across\)\)$/,
    );
    expect(report.notes.filter((note) => note.includes('not measurable'))).toEqual([]);
  });
});
