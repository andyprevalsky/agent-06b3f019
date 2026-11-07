/**
 * Benchmark check (C6/C21): in a finished run, every thinking row of the root agent and
 * of each code agent renders as a normal tool row with its duration, output tokens and
 * tok/s from recorded usage; and an agent is required to have thinking rows only when
 * the run's own records show it thought.
 *
 * Input: the root agent's messages exactly as GET /api/agents/:rootId returns them
 * (`.messages[]`: message_id, timestamp, text, role, metadata, file_pointer). Code
 * agents' transcripts are carrier rows in that same list (metadata.task_id +
 * metadata.code_agent_events). Optional `evidence[agentId].reasoningTokens`: reasoning
 * or thinking tokens from recorded usage that the caller hydrated for that agent
 * (Rose records no such field for the root today; the hook exists so a run that has one
 * is held to it).
 *
 * Per agent (root = `rootAgentId`, code agent = its task id):
 *  - ROWS EXIST. The root's rows are chosen exactly as the root work description does
 *    (filterMessagesForSubAgent: a browser agent's text rows are not the root's); a code
 *    agent's are the adapter's thought rows (buildCodeSession). Each row that carries a
 *    recorded generation is RENDERED through the production path (useToolData +
 *    ToolMessage) and must show the lightbulb tool row, "<n>s", "<n> tokens" and
 *    "<n> tok/s", never the animated indicator, with a plausible rate.
 *    A recorded generation whose implied rate exceeds the streaming bound is a response
 *    returned in one burst (an unstreamed gateway route): thoughtGeneration flags it, the
 *    row shows duration and tokens and no tok/s, and the check reports it as not
 *    measurable (response arrived in one burst, not streamed) without failing. A rate
 *    outside the bounds that is NOT such a flagged burst still fails.
 *    A row without a generation is "unmeasured". For a code agent the run's raw records
 *    decide (thoughtWindow): a thought whose bracketing usage samples (creation order, same
 *    turn) leave no tool running across the window was RECORDABLE, so the missing
 *    generation FAILS; otherwise it is "not measurable" with the reason (no sample before
 *    or after it, a tool running across, ...) and is only reported. A session that thought
 *    and recorded no usage samples at all fails. For the root, a run with run-agent thinking
 *    rows (the only root producer that records a generation) none of which carries one fails;
 *    a chat-router, DAG-reasoning or display-message row records no per-call usage and is
 *    reported.
 *  - NO ROWS. Evidence of thinking (the CLI recorded thinking blocks, or the supplied
 *    reasoningTokens > 0) with no row is a failure. Otherwise the verdict is
 *    "no thinking recorded for <agent> (N/A)": explicitly labeled, never a failure.
 * A run with no code agent fails: this check is for Rose-on-Rose code-agent runs.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Message } from '@/lib/api/types';

import { trajectoryActivity } from '../components/trajectoryWorkGroups';
import {
  MAX_STREAMING_TOKENS_PER_SECOND,
  thoughtGeneration,
  type ThoughtGeneration,
} from '../components/thoughtGeneration';
import { filterMessagesForSubAgent } from '../components/useMessageFiltering';
import { ToolMessage } from '../components/message-bubble/ToolMessage';
import { useToolData } from '../components/message-bubble/useToolData';
import { buildCodeSession } from '../hooks/codeSessionTurns';
import { thoughtWindow } from './thoughtWindow';
import { foldSessionTranscript, transcriptProvider } from '../hooks/codeSessionTranscript';

export interface ThoughtRowReport {
  messageId: string;
  outputTokens: number;
  durationMs: number;
  tokensPerSecond: number;
}

export interface UnmeasuredRow {
  messageId: string;
  /** Why the row carries no generation. */
  reason: string;
  /** True when the run's records prove it should have one. */
  failing: boolean;
}

export type AgentVerdict = 'checked' | 'n/a' | 'failed';

export interface AgentThinkingReport {
  agentId: string;
  /** Thinking rows in the work description. */
  thoughts: number;
  /** Rows with a recorded generation (duration · tokens · tok/s), each verified rendered. */
  measured: ThoughtRowReport[];
  unmeasured: UnmeasuredRow[];
  verdict: AgentVerdict;
}

export interface ThinkingRowsReport {
  ok: boolean;
  root: AgentThinkingReport;
  codeAgents: Array<AgentThinkingReport & { taskId: string }>;
  failures: string[];
  /** Non-failing, explicitly labeled lines (N/A agents, unmeasured rows and why). */
  notes: string[];
  /** One verdict line per agent, ready for a scorecard's verdict detail. */
  detail: string[];
}

export interface ThinkingEvidence {
  reasoningTokens?: number;
}

export interface ThinkingRowsOptions {
  /**
   * Plausible streaming speeds; providers range from ~20 (slow) to ~3,000 (Cerebras). The
   * ceiling defaults to the bound the row itself uses to call a response a burst
   * (MAX_STREAMING_TOKENS_PER_SECOND): one constant, not two.
   */
  minTokensPerSecond?: number;
  maxTokensPerSecond?: number;
  evidence?: Record<string, ThinkingEvidence>;
}

/** The row as the app draws it: useToolData → ToolMessage, the production thought-row path. */
function ThoughtRow({ message }: { message: Message }) {
  const data = useToolData({
    message,
    isStreaming: false,
    isAssistant: message.role === 'ASSISTANT',
    isTool: message.role === 'TOOL',
  });
  return data ? createElement(ToolMessage, { data }) : null;
}

function renderProblems(message: Message, generation: ThoughtGeneration): string[] {
  const html = renderToStaticMarkup(createElement(ThoughtRow, { message }));
  const problems: string[] = [];
  if (!html.includes('lucide-lightbulb')) problems.push('no lightbulb tool icon');
  if (!/Thought|Thinking/.test(html)) problems.push('no Thought/Thinking title');
  if (html.includes('thinking-indicator') || html.includes('thinking-animation'))
    problems.push('renders the animated thinking indicator');
  const rate = generation.tokensPerSecond;
  const shown = [
    `${(generation.durationMs / 1000).toFixed(1)}s`,
    `${generation.outputTokens.toLocaleString()} tokens`,
    ...(rate !== null ? [`${rate.toFixed(1)} tok/s`] : []),
  ];
  for (const text of shown) if (!html.includes(text)) problems.push(`does not show "${text}"`);
  if (rate === null && html.includes('tok/s')) problems.push('shows a tok/s for a burst');
  return problems;
}

type RowKind =
  'run-agent turn' | 'DAG reasoning' | 'chat router/generator' | 'display message' | 'other';

function rootRowKind(message: Message): RowKind {
  const metadata = message.metadata;
  // User-facing text posted by the display system (a code agent's report): not a model call.
  if (metadata?.source === 'display' || metadata?.requestingAgent) return 'display message';
  if (Array.isArray(metadata?.tool_calls)) return 'run-agent turn';
  if (metadata?.dagTaskIndex !== undefined) return 'DAG reasoning';
  if (typeof metadata?.streamId === 'string') return 'chat router/generator';
  return 'other';
}

/** The thought rows of the root's own work description (the production root filter). */
function rootThoughts(messages: Message[]): Message[] {
  return filterMessagesForSubAgent(messages, undefined, true).filter(
    (message) =>
      message.role !== 'SYSTEM' &&
      !message.metadata?.hidden &&
      trajectoryActivity(message)?.kind === 'thinking',
  );
}

function codeThoughts(messages: Message[], rootAgentId: string, taskId: string): Message[] {
  return buildCodeSession({
    messages,
    taskId,
    ownerAgentId: rootAgentId,
    provider: transcriptProvider(messages, taskId) ?? 'claude',
    sessionState: 'completed',
    sessionEndedAt: null,
    echoes: [],
  }).flatMap((entry) =>
    entry.kind === 'work'
      ? entry.turn.activities.filter((message) => message.metadata?.toolName === 'thought')
      : [],
  );
}

function codeTaskIds(messages: Message[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    const taskId = message.metadata?.task_id;
    if (typeof taskId === 'string' && Array.isArray(message.metadata?.code_agent_events))
      ids.add(taskId);
  }
  return [...ids];
}

interface Collected {
  report: AgentThinkingReport;
  failures: string[];
  notes: string[];
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function summary(who: string, report: AgentThinkingReport): string {
  if (report.verdict === 'n/a') return `${who}: N/A, no thinking recorded`;
  const rates = report.measured.map((row) => row.tokensPerSecond);
  const range = rates.length
    ? ` (${Math.round(Math.min(...rates))}–${Math.round(Math.max(...rates))} tok/s)`
    : '';
  const unmeasured = report.unmeasured.length ? `, ${report.unmeasured.length} unmeasured` : '';
  return `${who}: ${plural(report.thoughts, 'thinking row')}, ${report.measured.length} measured${range}${unmeasured}`;
}

function collect(
  agentId: string,
  who: string,
  rows: Message[],
  classify: (row: Message) => { reason: string; failing: boolean },
  recordedBlocks: number,
  options: Required<Pick<ThinkingRowsOptions, 'minTokensPerSecond' | 'maxTokensPerSecond'>> &
    ThinkingRowsOptions,
): Collected {
  const failures: string[] = [];
  const notes: string[] = [];
  const measured: ThoughtRowReport[] = [];
  const unmeasured: UnmeasuredRow[] = [];
  for (const row of rows) {
    const generation = thoughtGeneration(row.metadata);
    if (!generation) {
      unmeasured.push({ messageId: row.message_id, ...classify(row) });
      continue;
    }
    const rate = generation.tokensPerSecond;
    if (rate === null || generation.notMeasurable) {
      // A response returned in one burst: reported, not failed; the row must still render
      // its duration and tokens and no tok/s.
      unmeasured.push({
        messageId: row.message_id,
        reason: generation.notMeasurable ?? 'no streaming rate',
        failing: false,
      });
    } else {
      measured.push({
        messageId: row.message_id,
        outputTokens: generation.outputTokens,
        durationMs: generation.durationMs,
        tokensPerSecond: rate,
      });
      if (rate < options.minTokensPerSecond || rate > options.maxTokensPerSecond)
        failures.push(
          `${who}: thought ${row.message_id} runs at ${rate.toFixed(1)} tok/s ` +
            `(${generation.outputTokens} tokens / ${(generation.durationMs / 1000).toFixed(2)}s), ` +
            `outside ${options.minTokensPerSecond}–${options.maxTokensPerSecond}`,
        );
    }
    for (const problem of renderProblems(row, generation))
      failures.push(`${who}: thought ${row.message_id} ${problem}`);
  }
  for (const row of unmeasured) {
    const line = row.failing
      ? `${who}: thought ${row.messageId} carries no recorded generation (${row.reason})`
      : `${who}: thought ${row.messageId} not measurable (${row.reason})`;
    (row.failing ? failures : notes).push(line);
  }
  const reasoningTokens = options.evidence?.[agentId]?.reasoningTokens ?? 0;
  if (rows.length === 0) {
    const proof = [
      recordedBlocks > 0 ? plural(recordedBlocks, 'thinking block') + ' recorded by the CLI' : '',
      reasoningTokens > 0 ? `${reasoningTokens} reasoning tokens in recorded usage` : '',
    ].filter(Boolean);
    if (proof.length)
      failures.push(`${who}: thinking recorded (${proof.join('; ')}) but no thinking row is shown`);
    else notes.push(`no thinking recorded for ${who} (N/A)`);
  }
  const verdict: AgentVerdict = failures.length ? 'failed' : rows.length ? 'checked' : 'n/a';
  return {
    report: { agentId, thoughts: rows.length, measured, unmeasured, verdict },
    failures,
    notes,
  };
}

export function checkThinkingRows(
  messages: Message[],
  rootAgentId: string,
  { minTokensPerSecond = 1, maxTokensPerSecond = 5_000, evidence }: ThinkingRowsOptions = {},
): ThinkingRowsReport {
  const options = { minTokensPerSecond, maxTokensPerSecond, evidence };
  const failures: string[] = [];
  const notes: string[] = [];
  const detail: string[] = [];

  const rootRows = rootThoughts(messages);
  const root = collect(
    rootAgentId,
    'root',
    rootRows,
    (row) => {
      const kind = rootRowKind(row);
      return kind === 'run-agent turn'
        ? {
            reason:
              'run-agent turn without a usage window, e.g. a Fast Mode replay or a single-flush response',
            failing: false,
          }
        : { reason: `${kind} row: its producer records no per-call usage`, failing: false };
    },
    0,
    options,
  );
  // The run-agent loop is the one root producer that records a generation: if it wrote
  // thinking rows and not one carries it, recording is broken (not merely unavailable).
  const runAgentRows = rootRows.filter((row) => rootRowKind(row) === 'run-agent turn');
  if (runAgentRows.length > 0 && !runAgentRows.some((row) => thoughtGeneration(row.metadata))) {
    root.failures.push(
      `root: ${plural(runAgentRows.length, 'run-agent thinking row')}, none carries a recorded generation (tok/s)`,
    );
    root.report.verdict = 'failed';
  }
  failures.push(...root.failures);
  notes.push(...root.notes);
  detail.push(summary('root', root.report));

  const codeAgents = codeTaskIds(messages).map((taskId) => {
    const entries = foldSessionTranscript(messages, taskId);
    const samples = entries.filter(
      (entry) => entry.type === 'metrics' && entry.outputTokens != null && entry.usageScope,
    ).length;
    const prefix = `code:${taskId}:`;
    const collected = collect(
      taskId,
      `code agent ${taskId}`,
      codeThoughts(messages, rootAgentId, taskId),
      (row) => {
        // A session that thought but recorded no usage at all has a broken usage recorder.
        if (samples === 0)
          return { reason: 'no usage samples recorded for this session', failing: true };
        const verdict = thoughtWindow(entries, row.message_id.slice(prefix.length));
        return 'reason' in verdict
          ? { reason: verdict.reason, failing: false }
          : {
              reason: `recordable: usage samples seq ${verdict.fromSeq} to ${verdict.toSeq} bracket it (${verdict.tokens} tokens, no tool running across)`,
              failing: true,
            };
      },
      entries.filter((entry) => entry.type === 'thinking').length,
      options,
    );
    failures.push(...collected.failures);
    notes.push(...collected.notes);
    detail.push(summary(`code agent ${taskId}`, collected.report));
    return { ...collected.report, taskId };
  });
  if (codeAgents.length === 0) {
    failures.push('no code-agent transcript in the run');
    detail.push('code agents: none in the run');
  }
  return {
    ok: failures.length === 0,
    root: root.report,
    codeAgents,
    failures,
    notes,
    detail,
  };
}
