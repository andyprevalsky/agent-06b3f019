import { expect, it } from 'vitest';
import type { Message } from '@/lib/api';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';

export function registerBrowserPanelResumeCases(): void {
  it.each(['task_complete', 'session_paused'] as const)(
    'ignores a late %s from an older invocation of the same logical browser',
    (terminalAction) => {
      const event = (
        id: string,
        second: number,
        owner: string,
        action: NonNullable<Message['metadata']>['action_type'],
        url: string,
      ): Message => ({
        message_id: id,
        timestamp: `2026-10-26T17:03:0${second}.000Z`,
        role: 'TOOL',
        text: '',
        metadata: {
          toolName: 'spawn_browser_agent',
          task_id: 'logical-browser',
          toolCallId: owner,
          action_type: action,
          browser_url: url,
        },
      });
      const messages = [
        event('old', 1, 'old-call', 'browser', 'old-native'),
        event('current', 2, 'current-call', 'browser', 'new-native'),
        event('ready', 2, 'activity-call', 'session_init', 'new-native'),
        event('late-old-terminal', 3, 'old-call', terminalAction, 'old-native'),
      ];
      const live = [{ taskId: 'logical-browser', browserUrl: 'new-native' }];
      expect(computeActiveBrowserPanels(messages)).toEqual(live);
      expect(computeActiveBrowserPanels([...messages].reverse())).toEqual(live);
      expect(
        computeActiveBrowserPanels([
          ...messages,
          event('current-terminal', 4, 'current-call', terminalAction, 'new-native'),
        ]),
      ).toEqual([]);
    },
  );

  it.each([
    ['task', 'session_started'],
    ['tool-call', 'session_started'],
    ['task', 'session_init'],
    ['tool-call', 'session_init'],
  ] as const)(
    'reopens the same logical browser after a %s pause and %s readiness',
    (scope, readyAction) => {
      const event = (
        id: string,
        second: number,
        metadata: NonNullable<Message['metadata']>,
      ): Message => ({
        message_id: id,
        timestamp: `2026-10-26T17:03:0${second}.000Z`,
        role: 'TOOL',
        text: '',
        metadata: { toolName: 'spawn_browser_agent', toolCallId: 'same-inbox', ...metadata },
      });
      const messages = [
        event('initial', 1, {
          task_id: 'logical-browser',
          action_type: 'browser',
          browser_url: 'old-native',
        }),
        event('paused', 2, {
          ...(scope === 'task' ? { task_id: 'logical-browser' } : {}),
          action_type: 'session_paused',
          toolStatus: 'FINISHED',
        }),
        event('restored', 3, {
          task_id: 'logical-browser',
          action_type: readyAction,
          browser_url: 'restored-native',
          toolStatus: 'IN_PROGRESS',
        }),
        event('recording-cleanup', 4, {
          task_id: 'logical-browser',
          action_type: 'recording',
          browser_url: 'old-native',
          toolStatus: 'FINISHED',
        }),
      ];
      expect(computeActiveBrowserPanels(messages.slice(0, 2))).toEqual([]);
      const live = [{ taskId: 'logical-browser', browserUrl: 'restored-native' }];
      expect(computeActiveBrowserPanels(messages)).toEqual(live);
      expect(computeActiveBrowserPanels([...messages].reverse())).toEqual(live);
      expect(
        computeActiveBrowserPanels([
          ...messages,
          event('paused-again', 5, {
            ...(scope === 'task' ? { task_id: 'logical-browser' } : {}),
            action_type: 'session_paused',
            toolStatus: 'FINISHED',
          }),
        ]),
      ).toEqual([]);
      messages.push(
        event('completed', 5, {
          task_id: 'logical-browser',
          action_type: 'task_complete',
          toolStatus: 'FINISHED',
        }),
      );
      expect(computeActiveBrowserPanels(messages)).toEqual([]);
    },
  );

  it('starts a later invocation on the same logical browser after real completion', () => {
    const messages: Message[] = [
      {
        message_id: 'first',
        timestamp: '2026-10-26T17:03:01.000Z',
        role: 'TOOL',
        text: '',
        metadata: {
          task_id: 'logical-browser',
          toolName: 'spawn_browser_agent',
          toolCallId: 'old-call',
          action_type: 'browser',
          browser_url: 'old-native',
        },
      },
      {
        message_id: 'end',
        timestamp: '2026-10-26T17:03:02.000Z',
        role: 'TOOL',
        text: '',
        metadata: {
          task_id: 'logical-browser',
          toolName: 'spawn_browser_agent',
          toolCallId: 'old-call',
          action_type: 'task_complete',
        },
      },
      {
        message_id: 'next',
        timestamp: '2026-10-26T17:03:03.000Z',
        role: 'TOOL',
        text: '',
        metadata: {
          task_id: 'logical-browser',
          toolName: 'spawn_browser_agent',
          toolCallId: 'new-call',
          action_type: 'browser',
          browser_url: 'new-native',
        },
      },
    ];
    expect(computeActiveBrowserPanels(messages)).toEqual([
      { taskId: 'logical-browser', browserUrl: 'new-native' },
    ]);
  });

  it('does not reopen a paused browser for late verifier progress with a browser URL', () => {
    const messages: Message[] = [
      {
        message_id: 'first',
        timestamp: '2026-10-26T17:03:01.000Z',
        role: 'TOOL',
        text: '',
        metadata: {
          task_id: 'logical-browser',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          browser_url: 'old-native',
        },
      },
      {
        message_id: 'pause',
        timestamp: '2026-10-26T17:03:02.000Z',
        role: 'TOOL',
        text: '',
        metadata: {
          task_id: 'logical-browser',
          toolName: 'spawn_browser_agent',
          action_type: 'session_paused',
        },
      },
      {
        message_id: 'late',
        timestamp: '2026-10-26T17:03:03.000Z',
        role: 'TOOL',
        text: '',
        metadata: {
          task_id: 'logical-browser',
          toolName: 'spawn_browser_agent',
          action_type: 'system',
          browser_url: 'old-native',
          toolStatus: 'FINISHED',
        },
      },
    ];
    expect(computeActiveBrowserPanels(messages)).toEqual([]);
  });
}
