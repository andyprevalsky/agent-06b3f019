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
 *    A row without a generation is "unmeasured". It FAILS when the records prove it
 *    should have one: a code agent with turn-scoped usage samples (Claude Code), or a
 *    code agent with thinking rows and no usage samples at all; and when a root has
 *    run-agent thinking rows (the only root producer that records a generation) and none
 *    carries one. It is reported, not failed, when the producer cannot record one: a
 *    root chat-router or DAG-reasoning row (no per-call usage on the row), or a code
 *    agent with session-scoped usage (Codex: successive samples span tool runs).
 *  - NO ROWS. Evidence of thinking (the CLI recorded thinking blocks, or the supplied
 *    reasoningTokens > 0) with no row is a failure. Otherwise the verdict is
 *    "no thinking recorded for <agent> (N/A)": explicitly labeled, never a failure.
 * A run with no code agent fails: this check is for Rose-on-Rose code-agent runs.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Message } from '@/lib/api/types';

import { trajectoryActivity } from '../components/trajectoryWorkGroups';
import { thoughtGeneration, type ThoughtGeneration } from '../components/thoughtGeneration';
import { filterMessagesForSubAgent } from '../components/useMessageFiltering';
import { ToolMessage } from '../components/message-bubble/ToolMessage';
import { useToolData } from '../components/message-bubble/useToolData';
import { buildCodeSession } from '../hooks/codeSessionTurns';
import { foldSessionTranscript, transcriptProvider } from '../hooks/codeSessionTranscript';

export interface ThoughtRowReport extends ThoughtGeneration {
  messageId: string;
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
  /** Plausible generation speeds; providers range from ~20 (slow) to ~3,000 (Cerebras). */
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
  const shown = [
    `${(generation.durationMs / 1000).toFixed(1)}s`,
    `${generation.outputTokens.toLocaleString()} tokens`,
    `${generation.tokensPerSecond.toFixed(1)} tok/s`,
  ];
  for (const text of shown) if (!html.includes(text)) problems.push(`does not show "${text}"`);
  return problems;
}

type RowKind = 'run-agent turn' | 'DAG reasoning' | 'chat router/generator' | 'other';

function rootRowKind(message: Message): RowKind {
  const metadata = message.metadata;
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
    measured.push({ messageId: row.message_id, ...generation });
    if (
      generation.tokensPerSecond < options.minTokensPerSecond ||
      generation.tokensPerSecond > options.maxTokensPerSecond
    )
      failures.push(
        `${who}: thought ${row.message_id} runs at ${generation.tokensPerSecond.toFixed(1)} tok/s ` +
          `(${generation.outputTokens} tokens / ${(generation.durationMs / 1000).toFixed(2)}s), ` +
          `outside ${options.minTokensPerSecond}–${options.maxTokensPerSecond}`,
      );
    for (const problem of renderProblems(row, generation))
      failures.push(`${who}: thought ${row.message_id} ${problem}`);
  }
  for (const row of unmeasured) {
    const line = `${who}: thought ${row.messageId} carries no recorded generation (${row.reason})`;
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
              'run-agent turn without usage window, e.g. a Fast Mode replay or a sub-100 ms burst',
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
    const scopes = new Set(
      entries.filter((entry) => entry.type === 'metrics').map((entry) => entry.usageScope),
    );
    const samples = entries.filter(
      (entry) => entry.type === 'metrics' && entry.outputTokens != null && entry.usageScope,
    ).length;
    const collected = collect(
      taskId,
      `code agent ${taskId}`,
      codeThoughts(messages, rootAgentId, taskId),
      () => {
        if (samples === 0)
          return { reason: 'no usage samples recorded for this session', failing: true };
        if (!scopes.has('turn'))
          return {
            reason: 'session-scoped usage (Codex): successive samples span tool runs',
            failing: false,
          };
        return {
          reason: 'turn-scoped usage samples exist, so the window was recordable',
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
