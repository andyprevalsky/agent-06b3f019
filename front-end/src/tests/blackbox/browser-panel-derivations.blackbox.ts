import { describe, expect, it } from 'vitest';

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
  it('excludes finished browser tasks even when no task_complete action arrives', () => {
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
          action_type: 'system',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(msgs)).toEqual([]);
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
  it('excludes failed browser tasks even when no task_complete action arrives', () => {
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
          action_type: 'system',
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
