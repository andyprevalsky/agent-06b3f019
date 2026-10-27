import { describe, expect, it } from 'vitest';
import type { Message } from '@/lib/api';

import { deduplicateToolMessages } from '@/features/terminal-component-group/hooks/deduplicateToolMessages';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';

import prodChipLeakTranscriptJson from './browser-chip-leak-prod-85530622.fixture.json';

const prodChipLeakTranscript = prodChipLeakTranscriptJson as Parameters<
  typeof computeActiveBrowserPanels
>[0];

describe('computeActiveBrowserPanels', () => {
  it('returns panel for active browser tasks only', () => {
    const msgs = [
      {
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'system',
          browser_url: 'https://e.com',
        },
      },
    ] as never;
    const panels = computeActiveBrowserPanels(msgs);
    expect(panels).toEqual([{ taskId: 't1', browserUrl: 'https://e.com' }]);
  });
  it('returns panel for ready browser sessions using session_started action', () => {
    const msgs = [
      {
        metadata: {
          task_id: 'ready-task',
          toolName: 'spawn_browser_agent',
          action_type: 'session_started',
          title: 'Browser ready',
          browser_url: 'https://debug.steel.dev/session/ready',
        },
      },
    ] as never;
    expect(computeActiveBrowserPanels(msgs)).toEqual([
      { taskId: 'ready-task', browserUrl: 'https://debug.steel.dev/session/ready' },
    ]);
  });
  it('excludes completed tasks', () => {
    const msgs = [
      {
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'system',
          browser_url: 'x',
        },
      },
      { metadata: { task_id: 't1', action_type: 'task_complete' } },
    ] as never;
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });
  it('excludes completed tasks even when later cleanup messages exist', () => {
    const msgs = [
      {
        metadata: {
          task_id: 'failed',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
        },
      },
      {
        metadata: {
          task_id: 'failed',
          toolName: 'spawn_browser_agent',
          action_type: 'task_complete',
          toolStatus: 'ERROR',
        },
      },
      {
        metadata: {
          task_id: 'failed',
          toolName: 'spawn_browser_agent',
          action_type: 'recording',
          toolStatus: 'FINISHED',
        },
      },
      {
        metadata: {
          task_id: 'active',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'y',
        },
      },
    ] as never;
    expect(computeActiveBrowserPanels(msgs)).toEqual([{ taskId: 'active', browserUrl: 'y' }]);
  });
  // Every completion message the browser handler posts at task scope declares
  // action_type='task_complete' (handler.py is_completion_message=True call
  // sites), enforced by agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
  // ::test_browser_tool_events_declare_action_type.
  it('excludes finished browser tasks on the task_complete terminal', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'finished',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'task_complete',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });
  // action_type 'system' is the browser VERIFIER-progress type ("⚖️ Verifying
  // completion", "⚖️ Progress: N%" — handler.py:7669/7762/7912), not a terminal.
  // It must never close the panel, or a mid-run verifier pass hides a live
  // browser exactly the way "Payment card ready" did.
  it('keeps browser task active across a task-scoped verifier "system" message', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'verifier',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'system',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([{ taskId: 't1', browserUrl: 'x' }]);
  });
  it('keeps browser task active after task-scoped action messages finish', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'click',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          subAgentId: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'click',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([{ taskId: 't1', browserUrl: 'x' }]);
  });
  it('excludes failed browser tasks on the task_complete terminal', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'failed',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolName: 'spawn_browser_agent',
          action_type: 'task_complete',
          toolStatus: 'ERROR',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });
  it('excludes tasks when parent browser tool pauses before task-scoped cleanup arrives', () => {
    const msgs = [
      {
        metadata: {
          task_id: 't1',
          toolCallId: 'browser-call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
        },
      },
      {
        metadata: {
          toolCallId: 'browser-call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'session_paused',
        },
      },
    ] as never;
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });
  it('returns empty when no browser messages', () => {
    expect(computeActiveBrowserPanels([])).toEqual([]);
  });

  // Regression: prod agent 85530622-66ed-4a88-8c51-bd50370bcd8e (2026-07-18).
  // The spawn_browser_agent tool call failed with an HTTPStatusError raised
  // outside the browser task loop, so the terminal ERROR message was posted
  // at tool-call scope (toolCallId only — no task_id, no action_type). Four
  // browser chips stayed visible forever because terminal detection only
  // scanned task-scoped messages. Chip count must equal active browser
  // agents: zero once every tool call has reached a terminal state.
  it('hides all chips for the captured prod transcript where every browser tool call ended', () => {
    expect(computeActiveBrowserPanels(prodChipLeakTranscript)).toEqual([]);
  });

  it('excludes tasks whose owning tool call errored at tool-call scope (no task_id)', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'tool-error',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: "HTTPStatusError: Server error '500 Internal Server Error'",
        role: 'TOOL',
        metadata: {
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          toolStatus: 'ERROR',
          error: true,
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });

  it('keeps a retry task alive when an earlier sibling task completed under the same tool call', () => {
    // Same tool call spawns task A, A completes with a task-scoped
    // task_complete, then the call retries with task B. B's chip must stay
    // visible — a task-scoped terminal for A is not a tool-call terminal.
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init-a',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-a',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'a',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'done-a',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-a',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'task_complete',
          toolStatus: 'ERROR',
        },
      },
      {
        message_id: 'init-b',
        timestamp: '2026-01-01T00:00:03.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-b',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'b',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([{ taskId: 'task-b', browserUrl: 'b' }]);
  });

  it('keeps a relaunched browser visible when it reuses the task id of an ended run', () => {
    // Prod agent 447576b9 (2026-10-26): "go to instacart instead" made the root
    // kill browser run 1 (call-1) and spawn run 2 (call-2) in the background on
    // the SAME task_id. Run 1's task_complete must not hide run 2's chip while
    // the agents-running pane shows that browser running.
    type Rows = Parameters<typeof computeActiveBrowserPanels>[0];
    const row = (id: string, second: number, toolCallId: string, action_type: string) =>
      ({
        message_id: id,
        timestamp: `2026-10-26T15:59:${String(second).padStart(2, '0')}.000Z`,
        text: '',
        role: 'TOOL' as const,
        metadata: {
          toolName: 'spawn_browser_agent',
          task_id: 'task-shared',
          toolCallId,
          action_type,
          toolStatus: action_type === 'browser' ? ('IN_PROGRESS' as const) : ('FINISHED' as const),
          ...(action_type === 'browser' ? { browser_url: `https://live/${toolCallId}` } : {}),
        },
      }) as Rows[number];
    const msgs: Rows = [
      row('run1-init', 7, 'call-1', 'browser'),
      row('run1-done', 8, 'call-1', 'task_complete'),
      row('run1-diagnostics', 9, 'browser-diagnostics:task-shared', 'diagnostics'),
      row('run2-init', 27, 'call-2', 'browser'),
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([
      { taskId: 'task-shared', browserUrl: 'https://live/call-2' },
    ]);
    // Run 2's own terminal still closes the chip.
    const ended: Rows = [...msgs, row('run2-done', 40, 'call-2', 'task_complete')];
    expect(computeActiveBrowserPanels(ended)).toEqual([]);
  });

  it('never renders two panels while one browser tool call is retrying', () => {
    // Production-shaped invariant: Temporal retried the logical call with a new
    // task ID. Even when an input prefix lacks task A's terminal event, only the
    // newest logical attempt may render. The exact missing-terminal cause in the
    // reported trace remains preliminary.
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init-a',
        timestamp: '2026-07-19T11:58:37.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-a',
          toolCallId: 'browser-call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'https://kernel.example/live/a',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'init-b',
        timestamp: '2026-07-19T11:58:46.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-b',
          toolCallId: 'browser-call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'https://steel.example/live/b',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
    ];

    const panelsByPrefix = msgs.map((_, index) =>
      computeActiveBrowserPanels(msgs.slice(0, index + 1)),
    );
    expect(panelsByPrefix.every((panels) => panels.length <= 1)).toBe(true);
    expect(panelsByPrefix.at(-1)).toEqual([
      { taskId: 'task-b', browserUrl: 'https://steel.example/live/b' },
    ]);
  });

  it('excludes tasks whose owning tool call finished at tool-call scope without task_complete', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'tool-finished',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });

  // Prod agent c27b4f28 (2026-08-22): user rejected a 1-item DoorDash checkout.
  // write_lock_rejected ends the browser task but is not task_complete; without
  // this terminal the live status chip stayed visible after rejection.
  it('hides the panel when the user rejects a write-lock approval', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-08-22T19:39:27.726Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'd398cf8a-b084-4a6b-bb86-8b05fbe36875',
          toolCallId: '489d5b89-42cd-4d72-8fe6-f219303988cb',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'https://connect.steel.dev/v1/sessions/live/view',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'rejected',
        timestamp: '2026-08-22T19:55:56.257Z',
        text: 'User rejected with feedback',
        role: 'TOOL',
        metadata: {
          task_id: 'd398cf8a-b084-4a6b-bb86-8b05fbe36875',
          toolCallId: '489d5b89-42cd-4d72-8fe6-f219303988cb',
          toolName: 'spawn_browser_agent',
          action_type: 'write_lock_rejected',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });

  it('hides the panel when write_lock_rejected is tool-call-scoped without task_id', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-08-22T19:39:27.726Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'd398cf8a-b084-4a6b-bb86-8b05fbe36875',
          toolCallId: '489d5b89-42cd-4d72-8fe6-f219303988cb',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'https://connect.steel.dev/v1/sessions/live/view',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'rejected',
        timestamp: '2026-08-22T19:55:56.257Z',
        text: 'User rejected with feedback',
        role: 'TOOL',
        metadata: {
          toolCallId: '489d5b89-42cd-4d72-8fe6-f219303988cb',
          toolName: 'spawn_browser_agent',
          action_type: 'write_lock_rejected',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
  });

  it('keeps a sibling task alive when another task pauses with a task-scoped session_paused', () => {
    // session_paused with task_id is task-scoped like task_complete: it must
    // not close a sibling retry task under the same tool call. Only a
    // tool-call-scoped session_paused (no task_id) ends the whole call.
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init-a',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-a',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'a',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'paused-a',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-a',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'session_paused',
        },
      },
      {
        message_id: 'init-b',
        timestamp: '2026-01-01T00:00:03.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-b',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'b',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([{ taskId: 'task-b', browserUrl: 'b' }]);
  });

  it('does not close a task when a different tool call errors', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 't1',
          toolCallId: 'call-1',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'x',
          toolStatus: 'IN_PROGRESS' as const,
        },
      },
      {
        message_id: 'other-error',
        timestamp: '2026-01-01T00:00:02.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          toolCallId: 'call-2',
          toolName: 'spawn_browser_agent',
          toolStatus: 'ERROR',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([{ taskId: 't1', browserUrl: 'x' }]);
  });
});

describe('rotate_ip progress lifecycle', () => {
  it('renders one tool when streamed and persisted progress share the model tool-call id', () => {
    const messages: Message[] = [
      {
        message_id: 'streamed-rotate',
        timestamp: '2026-07-19T11:58:12.000Z',
        text: 'Starting rotate_ip...',
        role: 'TOOL' as const,
        metadata: {
          toolCallId: 'call-rotate-1',
          toolName: 'rotate_ip',
          toolStatus: 'IN_PROGRESS' as const,
          title: 'Starting rotate_ip...',
        },
      },
      {
        message_id: 'persisted-rotate',
        timestamp: '2026-07-19T11:58:12.100Z',
        text: '',
        role: 'TOOL' as const,
        metadata: {
          toolCallId: 'call-rotate-1',
          toolName: 'rotate_ip',
          toolStatus: 'IN_PROGRESS' as const,
          title: 'Rotating browser IP',
        },
      },
    ];

    const [rendered] = deduplicateToolMessages(messages);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.metadata?.toolCallId).toBe('call-rotate-1');
    expect(rendered[0]?.metadata?.title).toBe('Rotating browser IP');
  });
});
