/**
 * Blackbox (C21/C24): the benchmark check for thinking rows. Every thinking row that exists
 * is verified (rendered through the production thought-row path, plausible rate), a row
 * without a generation fails only when it was recordable, an agent is required to have
 * thinking rows only on evidence of thinking, and a response returned in one burst is
 * reported, not failed. The replays of real runs live in code-agent-streaming-runs.
 */
import { describe, expect, it } from 'vitest';
import { checkThinkingRows } from '@/features/terminal-component-group/benchmark/thinkingRowsCheck';
import { BURST_REASON } from '@/features/terminal-component-group/components/thoughtGeneration';
import type { Message } from '@/lib/api';
import { msg } from './code-agent-steering.fixtures';
import prodRun from './code-agent-thinking-prod-1a3d495c.fixture.json';

const TASK_ID = prodRun.task_id;
const goal = msg(
  {},
  {
    message_id: 'goal',
    role: 'USER',
    text: 'Whats our rose repo looking like?',
    timestamp: '2026-11-06T04:21:00.000Z',
  },
);

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
