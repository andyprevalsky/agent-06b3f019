/**
 * Benchmark check (C16) over a finished run: every agent reply renders as
 * markdown structure, not markdown syntax.
 *
 * Input: each run's messages exactly as GET /api/agents/<id> returns them
 * (`.messages[]`: {message_id, role, text, metadata}).
 *
 * Checked, each rendered through the component the transcript uses and
 * inspected with agentMarkdownViolations:
 *   root    every final answer (metadata.isUserAttentionMessage) through
 *           AttentionMessage, the transcript's final-answer component
 *   code    every code-agent reply / result, projected by buildCodeSession
 *           per task (as the code-agent view shows it), through AttentionMessage
 *   output  every code-agent command output from the same projection, through
 *           MarkdownText as the tool row body: one <pre>, the output verbatim
 *
 * Runs under vitest (jsdom + the app's Vite aliases); see
 * src/tests/blackbox/agent-markdown-benchmark.blackbox.tsx.
 */
import { render } from '@testing-library/react';

import { MarkdownText } from '@/features/terminal-component-group/components/MarkdownText';
import { AttentionMessage } from '@/features/terminal-component-group/components/message-bubble/AttentionMessage';
import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { transcriptProvider } from '@/features/terminal-component-group/hooks/codeSessionTranscript';
import type { Message } from '@/lib/api';

import { agentMarkdownViolations } from './agentMarkdownCheck';

export interface AgentRun {
  agentId: string;
  messages: Message[];
}

export interface AgentMarkdownViolation {
  agent_id: string;
  message_id: string;
  kind: 'root' | 'code' | 'output' | 'missing';
  problems: string[];
}

export interface AgentMarkdownReport {
  ok: boolean;
  checked: { root: number; code: number; output: number };
  violations: AgentMarkdownViolation[];
}

/** A run from a saved GET /api/agents/<id> body (or a bare messages array). */
export function agentRunFromJson(agentId: string, json: unknown): AgentRun {
  const messages = Array.isArray(json) ? json : (json as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) throw new Error(`${agentId}: no messages array`);
  const pagination = (json as { pagination?: { has_more?: boolean } } | null)?.pagination;
  if (pagination?.has_more) throw new Error(`${agentId}: messages are paginated`);
  return { agentId, messages: messages as Message[] };
}

function attentionText(message: Message): string | null {
  const metadata = message.metadata;
  if (metadata?.isUserAttentionMessage !== true) return null;
  const text =
    typeof metadata.attentionMessage === 'string' ? metadata.attentionMessage : message.text;
  return text.trim() ? text : null;
}

function codeTaskIds(messages: Message[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    const taskId = message.metadata?.task_id;
    if (typeof taskId === 'string' && Array.isArray(message.metadata?.code_agent_events)) {
      ids.add(taskId);
    }
  }
  return [...ids];
}

export function checkAgentMarkdownRuns(
  runs: AgentRun[],
  options: { requireRootReply?: boolean; requireCodeReply?: boolean } = {},
): AgentMarkdownReport {
  const checked = { root: 0, code: 0, output: 0 };
  const violations: AgentMarkdownViolation[] = [];
  for (const { agentId, messages } of runs) {
    const flag = (kind: AgentMarkdownViolation['kind'], id: string, problems: string[]) => {
      if (problems.length > 0)
        violations.push({ agent_id: agentId, message_id: id, kind, problems });
    };
    const checkReply = (kind: 'root' | 'code', message: Message, text: string) => {
      checked[kind] += 1;
      const { container, unmount } = render(
        <AttentionMessage attentionMessage={text} isWaiting={false} />,
      );
      flag(kind, message.message_id, agentMarkdownViolations(container, text));
      unmount();
    };
    for (const message of messages) {
      const text = attentionText(message);
      if (text) checkReply('root', message, text);
    }
    for (const taskId of codeTaskIds(messages)) {
      const entries = buildCodeSession({
        messages,
        taskId,
        ownerAgentId: agentId,
        provider: transcriptProvider(messages, taskId) ?? 'claude',
        sessionState: 'completed',
        sessionEndedAt: null,
        echoes: [],
      });
      const projected = entries.flatMap((e) =>
        e.kind === 'work' ? e.turn.activities : [e.message],
      );
      for (const message of projected) {
        const text = attentionText(message);
        if (text) {
          checkReply('code', message, text);
          continue;
        }
        // Command rows the projection builds from tool records (no carried-over action_type).
        const metadata = message.metadata;
        const isToolRecord =
          message.role === 'TOOL' &&
          metadata?.action_type === undefined &&
          metadata?.toolName !== 'thought' &&
          metadata?.toolName !== 'error';
        const output = isToolRecord ? message.text : '';
        if (!output.trim()) continue;
        checked.output += 1;
        const { container, unmount } = render(
          <MarkdownText text={output} className="tool-message-markdown" />,
        );
        const pres = container.querySelectorAll('pre').length;
        flag('output', message.message_id, pres === 1 ? [] : [`${pres} <pre> for one output`]);
        unmount();
      }
    }
  }
  const everyAgent = runs.map((run) => run.agentId).join(',');
  const missing = (who: string): AgentMarkdownViolation => ({
    agent_id: everyAgent,
    message_id: '',
    kind: 'missing',
    problems: [`no ${who} reply found`],
  });
  if (options.requireRootReply && checked.root === 0) violations.push(missing('root agent'));
  if (options.requireCodeReply && checked.code === 0) violations.push(missing('code agent'));
  return { ok: violations.length === 0, checked, violations };
}
