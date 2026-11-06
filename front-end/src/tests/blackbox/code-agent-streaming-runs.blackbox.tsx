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
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { checkThinkingRows } from '@/features/terminal-component-group/benchmark/thinkingRowsCheck';
import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { ToolMessage } from '@/features/terminal-component-group/components/message-bubble/ToolMessage';
import { useToolData } from '@/features/terminal-component-group/components/message-bubble/useToolData';
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

  it.each(['be1c90da', '9f709385'])(
    'the benchmark check passes run %s: every thought recorded, none merely reported',
    (run) => {
      const messages = Object.entries(runs[run].tasks).flatMap(([taskId, carriers]) =>
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
      const report = checkThinkingRows(messages, runs[run].agent_id);
      expect(report.failures).toEqual([]);
      for (const agent of report.codeAgents) {
        expect(agent.verdict).toBe('checked');
        expect(agent.unmeasured).toEqual([]);
        expect(agent.measured).toHaveLength(Object.keys(expected[run][agent.taskId]).length);
      }
    },
  );
});

function runMessages(run: string): Message[] {
  return Object.entries(runs[run].tasks).flatMap(([taskId, carriers]) =>
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
}

/** The thought row as the app draws it (useToolData -> ToolMessage). */
function renderThought(message: Message) {
  return render(
    createElement(function Row() {
      const data = useToolData({ message, isStreaming: false, isAssistant: false, isTool: true });
      return data ? createElement(ToolMessage, { data }) : null;
    }),
  );
}

/**
 * Run 4 (C24): the Claude subscription login was rate-limited, so the run was served by a
 * gateway that returned its final response in ONE burst: 463 tokens between two usage
 * samples 31 ms apart (after a 5.35 s wait). The projection recorded it and the row drew
 * 14,935.5 tok/s. A response that was not streamed has no measurable rate: the row shows
 * its duration and tokens only, and the benchmark check reports it instead of failing.
 */
describe('run 4: a response the gateway returned in one burst', () => {
  const taskId = '080d3457-94fd-4b6c-87fc-50c4554135be';
  const burstKey = Object.keys(expected.run4[taskId]).find((id) => id.endsWith('EV2dWL:0'))!;
  const steadyKey = Object.keys(expected.run4[taskId]).find((id) => id.endsWith('t69o9d:0'))!;
  const thoughtRow = (key: string) => {
    const entries = buildCodeSession({
      messages: runMessages('run4'),
      taskId,
      ownerAgentId: runs.run4.agent_id,
      provider: 'claude',
      sessionState: 'completed',
      sessionEndedAt: null,
      echoes: [],
    });
    return entries
      .flatMap((entry) => (entry.kind === 'work' ? entry.turn.activities : []))
      .find((message) => message.message_id === `code:${taskId}:${key}`)!;
  };

  it('still records its tokens and duration (463 tokens over 31 ms)', () => {
    expect(project('run4', taskId)[burstKey]).toEqual(expected.run4[taskId][burstKey]);
    expect(expected.run4[taskId][burstKey].output_tokens).toBe(463);
  });

  it('renders the burst row with its duration and tokens and NO tok/s', () => {
    const view = renderThought(thoughtRow(burstKey));
    expect(view.container).toHaveTextContent('463 tokens');
    expect(view.container).toHaveTextContent('0.0s');
    expect(view.container).not.toHaveTextContent('tok/s');
    view.unmount();
    const steady = renderThought(thoughtRow(steadyKey));
    expect(steady.container).toHaveTextContent('158.6 tok/s'); // a streamed row keeps its rate
  });

  it('the benchmark check reports the burst as not measurable instead of failing the run', () => {
    const report = checkThinkingRows(runMessages('run4'), runs.run4.agent_id);
    expect(report.failures).toEqual([]);
    expect(report.codeAgents[0].verdict).toBe('checked');
    expect(report.codeAgents[0].measured).toHaveLength(3);
    expect(report.codeAgents[0].unmeasured).toEqual([
      {
        messageId: `code:${taskId}:${burstKey}`,
        reason: 'response arrived in one burst, not streamed',
        failing: false,
      },
    ]);
    expect(report.notes).toContain(
      `code agent ${taskId}: thought code:${taskId}:${burstKey} not measurable (response arrived in one burst, not streamed)`,
    );
  });
});
