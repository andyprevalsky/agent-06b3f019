import { describe, expect, it } from 'vitest';

import { deduplicateToolMessages } from '@/features/terminal-component-group/hooks/deduplicateToolMessages';
import { useMessageRouting } from '@/features/terminal-component-group/components/message-bubble/useMessageRouting';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';

import prodChipLeakTranscriptJson from './browser-chip-leak-prod-85530622.fixture.json';
import paymentResumeTranscriptJson from './browser-panel-payment-resume-prod-7f354640.fixture.json';

const prodChipLeakTranscript = prodChipLeakTranscriptJson as Parameters<
  typeof computeActiveBrowserPanels
>[0];
const paymentResumeTranscript = paymentResumeTranscriptJson as Parameters<
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([{ taskId: 'task-b', browserUrl: 'b' }]);
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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
    const messages = [
      {
        message_id: 'streamed-rotate',
        timestamp: '2026-07-19T11:58:12.000Z',
        text: 'Starting rotate_ip...',
        role: 'TOOL' as const,
        metadata: {
          toolCallId: 'call-rotate-1',
          toolName: 'rotate_ip',
          toolStatus: 'IN_PROGRESS',
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
          toolStatus: 'IN_PROGRESS',
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

// Prod agent 7f354640-ffab-4098-b7ae-041ddf246c6f (2026-08-19): the browser agent
// paused at checkout for request_payment_card, the user approved, and the SAME
// browser task (ba744d18) resumed on the SAME Steel session and kept acting for
// another five minutes. The live panel vanished at the approval and the
// transcript chip read "completed". The workflow-scope "Payment card ready"
// event is pure progress, but it is emitted with toolName=spawn_browser_agent +
// task_id and NO action_type / NO subAgentId — byte-identical to the legacy
// terminal shape — so a progress event closed the browser task.
// It is the only untyped terminal-shaped message for ba744d18 in the fixture.
describe('browser panel survives approval-resume handoffs', () => {
  const RESUMED_TASK_ID = 'ba744d18-063f-40be-aa23-1f20cd7ce4ff';

  it('keeps the live panel after "Payment card ready" resumes the same browser task', () => {
    const panels = computeActiveBrowserPanels(paymentResumeTranscript);

    expect(panels.map((panel) => panel.taskId)).toContain(RESUMED_TASK_ID);
  });

  it('renders the browser chip as still running after "Payment card ready"', async () => {
    const { renderHook } = await import('@testing-library/react');
    const [rendered] = deduplicateToolMessages(
      paymentResumeTranscript as Parameters<typeof deduplicateToolMessages>[0],
    );
    const chipAnchor = rendered.find((message) => message.metadata?.title === 'Payment card ready');
    expect(chipAnchor).toBeDefined();

    // dedupByToolCallId is last-wins, so the approval event becomes the anchor
    // for the browser tool call. It must not read as a finished browser agent.
    const { result } = renderHook(() => useMessageRouting(chipAnchor!));
    expect(result.current.isBrowserAgentChipMessage).toBe(false);
  });

  it('still renders every genuine terminal chip in the historical prod transcript', async () => {
    const { renderHook } = await import('@testing-library/react');
    // The untyped-terminal fallback is kept for tool-call scope so transcripts
    // recorded before the explicit-action_type contract keep their chips. Guard
    // it: narrowing the predicate must never silently drop historical chips.
    const chipCount = prodChipLeakTranscript.filter((message) => {
      const { result } = renderHook(() => useMessageRouting(message));
      return result.current.isBrowserAgentChipMessage;
    }).length;

    expect(chipCount).toBe(7);
  });

  it('does not treat a workflow-scope approval-granted event as a browser terminal', () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'init',
        timestamp: '2026-08-19T18:04:39.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'write-lock-task',
          subAgentId: 'write-lock-task',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'https://connect.steel.dev/v1/sessions/abc/player',
          toolStatus: 'IN_PROGRESS',
        },
      },
      {
        message_id: 'granted',
        timestamp: '2026-08-19T18:05:00.000Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'write-lock-task',
          toolName: 'spawn_browser_agent',
          toolStatus: 'FINISHED',
          title: '\u2713 Write permission granted',
        },
      },
    ];

    expect(computeActiveBrowserPanels(msgs)).toEqual([
      {
        taskId: 'write-lock-task',
        browserUrl: 'https://connect.steel.dev/v1/sessions/abc/player',
      },
    ]);
  });

  it("treats the resumed activity's session_init event as a browser init", () => {
    const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
      {
        message_id: 'resumed-init',
        timestamp: '2026-08-19T18:11:10.763Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'resumed-task',
          subAgentId: 'resumed-task',
          toolName: 'spawn_browser_agent',
          action_type: 'session_init',
          browser_url: 'https://connect.steel.dev/v1/sessions/645c47ec/player',
          toolStatus: 'FINISHED',
        },
      },
    ];

    expect(computeActiveBrowserPanels(msgs)).toEqual([
      {
        taskId: 'resumed-task',
        browserUrl: 'https://connect.steel.dev/v1/sessions/645c47ec/player',
      },
    ]);
  });
});
