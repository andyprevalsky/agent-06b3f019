import { describe, expect, it } from 'vitest';

import { deduplicateToolMessages } from '@/features/terminal-component-group/hooks/deduplicateToolMessages';
import { useMessageRouting } from '@/features/terminal-component-group/components/message-bubble/useMessageRouting';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';
import { BROWSER_INIT_ACTION_TYPES } from '@/lib/backendToolNames';

import prodChipLeakTranscriptJson from './browser-chip-leak-prod-85530622.fixture.json';
import paymentResumeTranscriptJson from './browser-panel-payment-resume-prod-7f354640.fixture.json';

const prodChipLeakTranscript = prodChipLeakTranscriptJson as Parameters<
  typeof computeActiveBrowserPanels
>[0];
const paymentResumeTranscript = paymentResumeTranscriptJson as Parameters<
  typeof computeActiveBrowserPanels
>[0];

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

// The browser status bar keeps its own "is this session live again?" check.
// It used to hardcode ['browser','session_started','system'], so a resumed
// activity's session_init after a session_paused never cleared isDisconnected
// and the bar stayed greyed out over a live browser. Both consumers now share
// BROWSER_INIT_ACTION_TYPES; this pins that they cannot drift apart again.
describe('browser init action vocabulary is shared by every consumer', () => {
  it('treats every init action_type the status bar recognises as a panel init', () => {
    for (const actionType of BROWSER_INIT_ACTION_TYPES) {
      const msgs: Parameters<typeof computeActiveBrowserPanels>[0] = [
        {
          message_id: `init-${actionType}`,
          timestamp: '2026-08-19T18:11:10.763Z',
          text: '',
          role: 'TOOL',
          metadata: {
            task_id: `task-${actionType}`,
            subAgentId: `task-${actionType}`,
            toolName: 'spawn_browser_agent',
            action_type: actionType,
            browser_url: 'https://connect.steel.dev/v1/sessions/645c47ec/player',
            toolStatus: 'FINISHED',
          },
        },
      ];

      expect(computeActiveBrowserPanels(msgs)).toEqual([
        {
          taskId: `task-${actionType}`,
          browserUrl: 'https://connect.steel.dev/v1/sessions/645c47ec/player',
        },
      ]);
    }
  });

  it('includes session_init so a resumed session reconnects the status bar', () => {
    expect(BROWSER_INIT_ACTION_TYPES.has('session_init')).toBe(true);
  });
});
