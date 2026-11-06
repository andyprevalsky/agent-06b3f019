/**
 * Benchmark check (C6): in a finished run, the root agent's and every code agent's
 * thinking are tool rows of the work description, and their tok/s comes from
 * recorded output tokens over the recorded generation window.
 *
 * Input: the root agent's messages exactly as GET /api/agents/:rootId returns them
 * (`.messages[]`: message_id, timestamp, text, role, metadata, file_pointer). Code
 * agents' transcripts are carrier rows in that same list (metadata.task_id +
 * metadata.code_agent_events). The check runs the production projections: the root
 * work groups (groupTrajectoryWork / trajectoryActivity) and the code-session
 * adapter (buildCodeSession), then reads each thought's generation the way the
 * thought row does (thoughtGeneration). Nothing is re-derived here.
 */
import type { Message } from '@/lib/api/types';

import { groupTrajectoryWork, trajectoryActivity } from '../components/trajectoryWorkGroups';
import { thoughtGeneration, type ThoughtGeneration } from '../components/thoughtGeneration';
import { buildCodeSession } from '../hooks/codeSessionTurns';
import { transcriptProvider } from '../hooks/codeSessionTranscript';

export interface ThoughtRowReport extends ThoughtGeneration {
  messageId: string;
}

export interface AgentThinkingReport {
  /** Thinking rows in the work description. */
  thoughts: number;
  /** Rows with a recorded generation (duration · tokens · tok/s). */
  measured: ThoughtRowReport[];
}

export interface ThinkingRowsReport {
  ok: boolean;
  root: AgentThinkingReport & { outsideWorkDescription: string[] };
  codeAgents: Array<AgentThinkingReport & { taskId: string }>;
  failures: string[];
}

export interface ThinkingRowsOptions {
  /** Plausible generation speeds; providers range from ~20 (slow) to ~3,000 (Cerebras). */
  minTokensPerSecond?: number;
  maxTokensPerSecond?: number;
}

function measured(messages: Message[]): ThoughtRowReport[] {
  return messages.flatMap((message) => {
    const generation = thoughtGeneration(message.metadata);
    return generation ? [{ messageId: message.message_id, ...generation }] : [];
  });
}

function rootThinking(messages: Message[]) {
  const grouping = groupTrajectoryWork(messages, 'COMPLETED');
  const thoughts = messages.filter((message) => trajectoryActivity(message)?.kind === 'thinking');
  return {
    thoughts: thoughts.length,
    measured: measured(thoughts),
    outsideWorkDescription: thoughts
      .filter((message) => !grouping.foldedIds.has(message.message_id))
      .map((message) => message.message_id),
  };
}

function codeAgentThinking(messages: Message[], rootAgentId: string, taskId: string) {
  const entries = buildCodeSession({
    messages,
    taskId,
    ownerAgentId: rootAgentId,
    provider: transcriptProvider(messages, taskId) ?? 'claude',
    sessionState: 'completed',
    sessionEndedAt: null,
    echoes: [],
  });
  const thoughts = entries.flatMap((entry) =>
    entry.kind === 'work'
      ? entry.turn.activities.filter((message) => message.metadata?.toolName === 'thought')
      : [],
  );
  return { taskId, thoughts: thoughts.length, measured: measured(thoughts) };
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

export function checkThinkingRows(
  messages: Message[],
  rootAgentId: string,
  { minTokensPerSecond = 1, maxTokensPerSecond = 5_000 }: ThinkingRowsOptions = {},
): ThinkingRowsReport {
  const failures: string[] = [];
  const implausible = (who: string, rows: ThoughtRowReport[]) => {
    for (const row of rows) {
      if (row.tokensPerSecond < minTokensPerSecond || row.tokensPerSecond > maxTokensPerSecond)
        failures.push(
          `${who}: thought ${row.messageId} runs at ${row.tokensPerSecond.toFixed(1)} tok/s ` +
            `(${row.outputTokens} tokens / ${(row.durationMs / 1000).toFixed(2)}s), outside ` +
            `${minTokensPerSecond}–${maxTokensPerSecond}`,
        );
    }
  };
  const root = rootThinking(messages);
  if (root.thoughts === 0) failures.push('root: no thinking rows in the work description');
  if (root.outsideWorkDescription.length > 0)
    failures.push(`root: thinking outside the work description: ${root.outsideWorkDescription}`);
  if (root.thoughts > 0 && root.measured.length === 0)
    failures.push('root: no thinking row carries a recorded generation (tok/s)');
  implausible('root', root.measured);
  const codeAgents = codeTaskIds(messages).map((taskId) =>
    codeAgentThinking(messages, rootAgentId, taskId),
  );
  if (codeAgents.length === 0) failures.push('no code-agent transcript in the run');
  for (const agent of codeAgents) {
    const who = `code agent ${agent.taskId}`;
    if (agent.thoughts === 0) failures.push(`${who}: no thinking rows`);
    else if (agent.measured.length === 0)
      failures.push(`${who}: no thinking row carries a recorded generation (tok/s)`);
    implausible(who, agent.measured);
  }
  return { ok: failures.length === 0, root, codeAgents, failures };
}
