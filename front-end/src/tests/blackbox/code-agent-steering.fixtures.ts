/**
 * Fixtures for code-agent steering blackbox tests (Rose Desktop rows 44-47, 51).
 * Wire shapes follow features/terminal-component-group/hooks/codeAgentContract.ts.
 */
import type { Message } from '@/lib/api';

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
};

export function questionMessage(display: Record<string, unknown> = {}) {
  return msg(
    {
      toolName: 'display',
      toolStatus: 'IN_PROGRESS',
      display: { ...QUESTION_DISPLAY, ...display },
      from_code_agent: { provider: 'codex', task_id: 'task-1' },
    },
    { text: QUESTION_DISPLAY.question },
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
