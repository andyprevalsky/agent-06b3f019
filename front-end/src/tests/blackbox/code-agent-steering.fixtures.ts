/**
 * Fixtures for code-agent steering blackbox tests (Rose Desktop rows 44-47, 51).
 * Wire shapes follow features/terminal-component-group/hooks/codeAgentContract.ts.
 */
import { createElement, type ReactNode } from 'react';
import { AgentContext } from '@/features/agent-context';
import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';
import {
  CodeAgentViewContext,
  type OpenCodeAgent,
} from '@/features/terminal-component-group/components/code-agent-view/codeAgentViewState';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import type { Message } from '@/lib/api';
import { makeAgentCtx } from './message-bubble.fixtures';
import { renderWithProviders } from './test-wrapper';

export const ROOT_AGENT_ID = 'root-agent-1';
export const API_BASE = 'http://localhost:3001/api';

let seq = 0;

export function msg(
  metadata: Record<string, unknown>,
  overrides: Partial<Omit<Message, 'metadata'>> = {},
): Message {
  seq += 1;
  return {
    message_id: overrides.message_id ?? `m-${seq}`,
    timestamp: overrides.timestamp ?? new Date(Date.UTC(2026, 9, 20, 12, 0, seq)).toISOString(),
    text: overrides.text ?? '',
    role: overrides.role ?? 'TOOL',
    metadata,
    ...(overrides.file_pointer ? { file_pointer: overrides.file_pointer } : {}),
  };
}

export function codeAgent(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'task-1',
    provider: 'codex',
    target: 'cloud',
    branch: 'rose-ui/polish/speed',
    state: 'live',
    started_at: '2026-10-20T12:00:00.000Z',
    title: '3-state speed button',
    ...overrides,
  };
}

/** The spawn_claude_code_agent anchor carrying a `code_agent` snapshot. */
export function chipMessage(codeAgentOverrides: Record<string, unknown> = {}, extra = {}) {
  const meta = codeAgent(codeAgentOverrides);
  return msg({
    toolName: 'spawn_claude_code_agent',
    toolCallId: `call-${meta.task_id as string}`,
    task_id: meta.task_id,
    action_type: 'claude_code_started',
    toolStatus: 'IN_PROGRESS',
    code_provider: meta.provider,
    code_agent: meta,
    ...extra,
  });
}

/** A task-scoped, hidden transcript row (rides the existing INSERT path). */
export function eventsMessage(events: unknown[], taskId = 'task-1') {
  return msg({
    toolName: 'spawn_claude_code_agent',
    task_id: taskId,
    subAgentId: taskId,
    action_type: 'code_agent_events',
    hidden: true,
    code_agent_events: events,
  });
}

/** A delivered direct turn as persisted by the backend (directChatService). */
export function directTurnMessage(text = 'Keep the 26px button', taskId = 'task-1') {
  return msg(
    {
      toolName: 'spawn_claude_code_agent',
      title: 'You',
      task_id: taskId,
      action_type: 'user_direct_turn',
      code_provider: 'claude',
      subAgentId: taskId,
      direct_turn_id: 'turn-1',
      isDirectCodeTurn: true,
      toolCallId: `call-${taskId}`,
    },
    { text },
  );
}

export const LIVE_EVENTS = [
  {
    type: 'thinking',
    ts: '2026-10-20T12:00:10.000Z',
    text: 'FastModeToggle is a boolean today; widen it to three states.',
  },
  {
    type: 'message',
    ts: '2026-10-20T12:00:16.000Z',
    text: "I'll widen the existing toggle to three states instead of adding a new control.",
  },
  {
    type: 'tool',
    ts: '2026-10-20T12:00:20.000Z',
    tool: { name: 'Read', target: 'front-end/src/…/FastModeToggle.tsx' },
  },
  {
    type: 'tool',
    ts: '2026-10-20T12:00:30.000Z',
    tool: { name: 'Edit', target: 'FastModeToggle.tsx', added: 54, removed: 22 },
  },
  {
    type: 'tool',
    ts: '2026-10-20T12:00:40.000Z',
    tool: {
      name: 'Run',
      target: 'npx vitest run fast-mode.blackbox.tsx',
      result: '✓ 3 passed',
      ok: true,
    },
  },
];

/** `requestingAgent` the backend stamps on code-agent rows (agent-tools/service.ts). */
export function codexRequester(taskId = 'task-1') {
  return {
    kind: 'code_agent',
    agent_id: ROOT_AGENT_ID,
    label: 'Codex',
    provider: 'codex',
    task_id: taskId,
  };
}

/** `display` metadata of a pinned question (agent-tools/questionService.ts, L-DISPLAY b10b038c1). */
export const QUESTION_DISPLAY = {
  placement: 'pinned',
  kind: 'question',
  question:
    'Should Ultrafast be the default speed for every account, or only for accounts behind the rose-user-ui flag?',
  options: [
    {
      label: 'Only behind the flag',
      description:
        "Only your account gets Ultrafast by default; everyone else keeps today's speed.",
      recommended: true,
    },
    { label: 'Everyone', description: 'All accounts default to Ultrafast. Higher provider cost.' },
    {
      label: 'Signed-in users only',
      description: 'Visitors stay on Normal; any signed-in account gets Ultrafast.',
    },
  ],
  allow_other: true,
  question_id: 'q-1',
  items: [],
  deliver_to: 'user',
  routed_agent_id: ROOT_AGENT_ID,
};

/**
 * A code agent's pinned question exactly as the backend writes it: a TOOL row
 * `display` (IN_PROGRESS → FINISHED when answered) in the session agent's
 * trajectory, grouped under the code task.
 */
export function questionMessage(
  display: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const merged = { ...QUESTION_DISPLAY, ...display };
  return msg(
    {
      toolCallId: `agent-tools:${merged.question_id as string}`,
      toolName: 'display',
      toolStatus: 'IN_PROGRESS',
      title: 'Codex asks',
      isUserAttentionMessage: true,
      attentionMessage: merged.question,
      attentionRequestId: merged.question_id,
      display: merged,
      requestingAgent: codexRequester(),
      excludeFromModel: true,
      subAgentId: 'task-1',
      task_id: 'task-1',
      ...extra,
    },
    { text: merged.question as string },
  );
}

export function signIn() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
}

// ── Agent-to-agent rows (backend agentGraphSendService, L-A2A) ──────────────

const CODEX_PARTY = {
  id: 'task-1',
  kind: 'code',
  provider: 'codex',
  owner_agent_id: 'root-agent-1',
  label: 'Codex',
};
const ROOT_PARTY = { id: ROOT_AGENT_ID, kind: 'agent', label: 'Root agent' };

/** Code-agent timeline row (TOOL, action_type 'agent_message') on the session owner. */
export function a2aTimelineMessage(
  direction: 'sent' | 'received',
  text: string,
  messageId: string,
) {
  const sent = direction === 'sent';
  const from = sent ? CODEX_PARTY : { id: ROOT_AGENT_ID, kind: 'agent', label: 'Root agent' };
  const to = sent
    ? { id: ROOT_AGENT_ID, kind: 'agent', label: 'Root agent' }
    : { id: 'task-1', kind: 'code', label: 'Codex' };
  return msg(
    {
      a2a: { kind: 'message', message_id: messageId, from, to, text, direction },
      idempotencyKey: `a2a:${from.id}:${messageId}:${direction}`,
      title: sent ? 'Codex → Root agent' : 'Root agent → Codex',
      task_id: 'task-1',
      subAgentId: 'task-1',
      action_type: 'agent_message',
      code_provider: 'codex',
      toolCallId: 'call-task-1',
      toolName: 'spawn_claude_code_agent',
    },
    // Received rows keep the LLM framing in `text`; a2a.text holds the raw words.
    {
      text: sent
        ? text
        : `[Message from Root agent, agent_id ${ROOT_AGENT_ID}. Reply with send_message_to_agent if a reply is needed]\n\n${text}`,
    },
  );
}

/** USER row delivered to a Rose agent by a code agent (text carries the LLM framing). */
export function a2aInboundUserMessage(
  kind: 'message' | 'question',
  text: string,
  to: { id: string; label: string } = { id: ROOT_PARTY.id, label: ROOT_PARTY.label },
) {
  const what = kind === 'question' ? 'Question' : 'Message';
  const reply =
    kind === 'question'
      ? 'Answer with send_message_to_agent; if you cannot, ask your parent the same way (agent_id "parent")'
      : 'Reply with send_message_to_agent if a reply is needed';
  return msg(
    {
      a2a: {
        kind,
        message_id: `client-${kind}`,
        from: CODEX_PARTY,
        to: { id: to.id, kind: 'agent', label: to.label },
        text,
      },
      idempotencyKey: `a2a:task-1:client-${kind}`,
      title: `Codex → ${to.label}`,
    },
    { role: 'USER', text: `[${what} from Codex, agent_id task-1. ${reply}]\n\n${text}` },
  );
}

// ── Render helpers (no JSX: this file is shared by several blackbox files) ──

export function WithAgent({
  messages,
  children,
  selectedAgentId = ROOT_AGENT_ID,
}: {
  messages: Message[];
  children?: ReactNode;
  selectedAgentId?: string;
}) {
  return createElement(
    AgentContext.Provider,
    { value: makeAgentCtx({ messages, selectedAgentId }) },
    children,
  );
}

export function renderChip(messages: Message[], roseDesktop = true) {
  return renderWithProviders(
    createElement(WithAgent, { messages }, createElement(ClaudeCodeChip, { taskId: 'task-1' })),
    { roseDesktop },
  );
}

/** The chip inside a code-agent view provider (Rose Desktop terminal); `open` spies Maximize. */
export function renderChipWithView(
  messages: Message[],
  open: (agent: OpenCodeAgent) => void,
  taskId = 'task-1',
) {
  const value = { openCodeAgent: null, open, close: () => {} };
  return renderWithProviders(
    createElement(
      CodeAgentViewContext.Provider,
      { value },
      createElement(
        WithAgent,
        { messages },
        createElement(ClaudeCodeChip, { taskId, toolCallId: `call-${taskId}` }),
      ),
    ),
    { roseDesktop: true },
  );
}

export interface RenderItemsOptions {
  roseDesktop?: boolean;
  currentAnimatingId?: string | null;
  onAnimationComplete?: () => void;
  selectedAgentId?: string;
  /** Rendered after the list inside the same agent context (e.g. PinnedQuestionMount). */
  after?: ReactNode;
}

export function renderItems(messages: Message[], options: RenderItemsOptions = {}) {
  const selectedAgentId = options.selectedAgentId ?? ROOT_AGENT_ID;
  return renderWithProviders(
    createElement(
      WithAgent,
      { messages, selectedAgentId },
      createElement(MessageListItems, {
        filteredMessages: messages,
        streamingMetricsBySubAgentId: new Map(),
        currentAnimatingId: options.currentAnimatingId ?? null,
        onAnimationComplete: options.onAnimationComplete ?? (() => {}),
        selectedAgentId,
        exploreStepMap: new Map(),
        waitForCheckMap: new Map(),
      }),
      options.after,
    ),
    { roseDesktop: options.roseDesktop ?? true },
  );
}

/** Andy's 2026-10-26 BTC session (prod shape): goal record, a later Rose message, Codex's message. */
export function btcRows(ownerId: string, taskId: string): Message[] {
  const records = [
    // Rose's initial goal (prod shape: id "goal", seq 0, sender agent).
    {
      id: 'goal',
      seq: 0,
      type: 'message',
      role: 'user',
      sender: 'agent',
      text: 'Chart BTC for 24h',
      ts: '2026-10-20T12:00:01.000Z',
    },
    {
      id: 't1',
      seq: 1,
      type: 'tool',
      ts: '2026-10-20T12:00:20.000Z',
      tool: { name: 'Edit', target: 'chart.py', added: 40, removed: 0 },
    },
    // A later Rose → Codex message: coordination, folded into the work.
    {
      id: 'rose2',
      seq: 2,
      type: 'message',
      role: 'user',
      sender: 'agent',
      text: 'Use UTC labels',
      ts: '2026-10-20T12:00:30.000Z',
    },
    { id: 'r1', seq: 3, type: 'result', text: 'Finished', ts: '2026-10-20T12:02:07.000Z' },
  ];
  const codexMessage = msg(
    {
      toolName: 'send_message_to_user',
      toolStatus: 'FINISHED',
      isUserAttentionMessage: true,
      attentionMessage: 'Chart is ready',
      sendMessageToUser: true,
      task_id: taskId,
      requestingAgent: {
        kind: 'code_agent',
        agent_id: ownerId,
        label: 'Codex',
        provider: 'codex',
        task_id: taskId,
      },
    },
    { text: 'Chart is ready' },
  );
  return [
    chipMessage(
      {
        state: 'completed',
        ended_at: '2026-10-20T12:02:08.000Z',
        summary: {
          commit: 'ca85dd1aa',
          branch: 'rose/btc',
          files: [{ path: 'AGENTS.md', added: 40, removed: 0 }],
        },
      },
      {
        code_session: {
          code_session_id: 'cs-1',
          branch: 'rose/btc',
          merge_target: 'main',
          pushed: true,
        },
      },
    ),
    eventsMessage(records),
    codexMessage,
    msg(
      {
        toolName: 'spawn_claude_code_agent',
        toolCallId: `call-${taskId}`,
        toolStatus: 'FINISHED',
        task_id: taskId,
        action_type: 'task_complete',
        success: true,
        code_provider: 'codex',
      },
      { text: 'Finished' },
    ),
  ];
}
