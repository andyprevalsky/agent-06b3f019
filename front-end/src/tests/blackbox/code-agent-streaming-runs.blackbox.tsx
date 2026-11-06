/**
 * Blackbox (C22): replays the transcripts of two integrated benchmark runs (be1c90da,
 * 9f709385; four Claude Code tasks, 18 thinking rows; structural skeletons with all text
 * removed) through the production projection (buildCodeSession) and requires every
 * thought to carry the generation its bracketing usage samples define.
 *
 * `expected` in the fixture is derived from the raw records alone: a thought's call
 * window is the usage sample before it and the usage sample after it (creation order,
 * same native turn); tokens = the samples' difference. It agrees with the 8 rows the
 * projection already recorded correctly, and every one of the 18 rows is recordable.
 * Before the fix 10 rows carried none, from two causes:
 *  1. the CLI upserts its lifecycle record, so a later "turn ended" revision keeps the
 *     "started" revision's low `seq`; the turn closed before any activity, the next
 *     usage sample (the call's message_start) arrived with no open turn and was dropped,
 *     and the first thought of each turn had no baseline sample;
 *  2. Claude Code runs a tool as soon as its tool_use block completes, so a tool created
 *     inside the call's window can finish before its message_delta; the "tool finished
 *     inside the window" guard read that as a tool run.
 */
import { describe, expect, it } from 'vitest';
import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import type { Message } from '@/lib/api';
import { msg } from './code-agent-steering.fixtures';
import fixture from './code-agent-streaming-runs.fixture.json';

type Generation = { output_tokens: number; started_at: string; ended_at: string };
type Carrier = { message_id: string; timestamp: string; events: unknown[] };
const runs = fixture.runs as Record<string, { agent_id: string; tasks: Record<string, Carrier[]> }>;
const expected = fixture.expected as Record<string, Record<string, Record<string, Generation>>>;

function project(run: string, taskId: string) {
  const messages: Message[] = runs[run].tasks[taskId].map((carrier) =>
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
  );
  const entries = buildCodeSession({
    messages,
    taskId,
    ownerAgentId: runs[run].agent_id,
    provider: 'claude',
    sessionState: 'completed',
    sessionEndedAt: null,
    echoes: [],
  });
  const prefix = `code:${taskId}:`;
  return Object.fromEntries(
    entries
      .flatMap((entry) => (entry.kind === 'work' ? entry.turn.activities : []))
      .filter((message) => message.metadata?.toolName === 'thought')
      .map((message) => [
        message.message_id.slice(prefix.length),
        (message.metadata?.generation as Generation | undefined) ?? null,
      ]),
  );
}

const cases = Object.entries(expected).flatMap(([run, tasks]) =>
  Object.keys(tasks).map((taskId) => [run, taskId] as const),
);

describe('replaying the integrated runs through the production projection', () => {
  it.each(cases)('%s %s: every thought carries its bracketing generation', (run, taskId) => {
    expect(project(run, taskId)).toEqual(expected[run][taskId]);
  });

  it('cause 1: the first thought of a turn is bracketed although its baseline sample arrived with no turn open', () => {
    const generations = project('be1c90da', '24f6a6ab-eaa0-49c6-84ee-47064216b05b');
    const first = Object.entries(generations).find(([id]) => id.endsWith('FE28ivM8MQCWDUFoFw:0'));
    expect(first?.[1]).toMatchObject({ output_tokens: 215 }); // 5 -> 220 over the call's 1.76 s
  });

  it("cause 2: a tool created in the call's window and finished before its message_delta does not void it", () => {
    const generations = project('be1c90da', '24f6a6ab-eaa0-49c6-84ee-47064216b05b');
    const streaming = Object.entries(generations).find(([id]) =>
      id.endsWith('FEY91he9L8wzRkugxw:0'),
    );
    expect(streaming?.[1]).toMatchObject({ output_tokens: 148 }); // 561 -> 709; the Run finished 1 ms before the delta
  });
});
