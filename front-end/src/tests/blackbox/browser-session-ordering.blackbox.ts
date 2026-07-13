import { describe, expect, it } from 'vitest';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';
import type { Message } from '@/features/terminal/types';

describe('browser session event ordering', () => {
  it('keeps the newest Kernel live-view URL when input messages are not timestamp ordered', () => {
    const messages: Message[] = [
      {
        message_id: 'new-session-action',
        timestamp: '2026-07-13T03:25:43.962Z',
        text: 'Navigating in resumed browser',
        role: 'TOOL',
        metadata: {
          task_id: 'stable-browser-task',
          subAgentId: 'stable-browser-task',
          toolName: 'spawn_browser_agent',
          action_type: 'goto',
          toolStatus: 'IN_PROGRESS',
          browser_url: 'https://proxy.yul-new.onkernel.com:8443/browser/live/new?readOnly=true',
        },
      },
      {
        message_id: 'old-session-init-delivered-late',
        timestamp: '2026-07-13T01:29:32.715Z',
        text: 'Browser initialized',
        role: 'TOOL',
        metadata: {
          task_id: 'stable-browser-task',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          toolStatus: 'IN_PROGRESS',
          browser_url: 'https://proxy.yul-old.onkernel.com:8443/browser/live/deleted?readOnly=true',
        },
      },
    ];

    expect(computeActiveBrowserPanels(messages)).toEqual([
      {
        taskId: 'stable-browser-task',
        browserUrl: 'https://proxy.yul-new.onkernel.com:8443/browser/live/new?readOnly=true',
      },
    ]);
  });

  it('uses the persisted message id when Kernel events have equal timestamps', () => {
    const timestamp = '2026-07-13T03:25:43.962Z';
    const messages: Message[] = [
      {
        message_id: 'z-new-session-action',
        timestamp,
        text: 'Navigating in resumed browser',
        role: 'TOOL',
        metadata: {
          task_id: 'equal-timestamp-browser-task',
          subAgentId: 'equal-timestamp-browser-task',
          toolName: 'spawn_browser_agent',
          action_type: 'goto',
          toolStatus: 'IN_PROGRESS',
          browser_url: 'https://proxy.yul-new.onkernel.com:8443/browser/live/new?readOnly=true',
        },
      },
      {
        message_id: 'a-old-session-init-delivered-late',
        timestamp,
        text: 'Browser initialized',
        role: 'TOOL',
        metadata: {
          task_id: 'equal-timestamp-browser-task',
          toolName: 'spawn_browser_agent',
          action_type: 'browser',
          toolStatus: 'IN_PROGRESS',
          browser_url: 'https://proxy.yul-old.onkernel.com:8443/browser/live/deleted?readOnly=true',
        },
      },
    ];

    expect(computeActiveBrowserPanels(messages)).toEqual([
      {
        taskId: 'equal-timestamp-browser-task',
        browserUrl: 'https://proxy.yul-new.onkernel.com:8443/browser/live/new?readOnly=true',
      },
    ]);
  });
});
