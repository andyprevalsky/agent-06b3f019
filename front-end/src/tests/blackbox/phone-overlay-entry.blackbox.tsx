/** [expanded + task phone event] -> existing fullscreen open event once; collapsed/foreign stay idle. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';

const fixture = vi.hoisted(() => ({
  expanded: true,
  fullscreen: false,
  messages: [] as unknown[],
}));
vi.mock('@/features/terminal-component-group/hooks', () => ({
  useAgentContext: () => ({
    agent: { agent_id: 'agent-a' },
    messages: fixture.messages,
    selectedAgentId: 'agent-a',
  }),
}));
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/useBrowserStatusBarState',
  () => ({
    useBrowserStatusBarState: () => ({
      readOnly: false,
      pendingAuthAssistance: null,
      pendingWriteLockApproval: null,
      isDisconnected: false,
      outputSchema: undefined,
      browserSessionMetadata: null,
      stepProgress: null,
    }),
  }),
);
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/useBrowserStatusBarUi',
  () => ({
    useBrowserStatusBarUi: () => ({
      isExpanded: fixture.expanded,
      isFullscreen: fixture.fullscreen,
      browserUrl: 'https://example.com',
      isLive: true,
      isUserControlling: false,
      hasReconnected: false,
    }),
  }),
);
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/useRefreshedAuthAssistanceUrl',
  () => ({ useRefreshedAuthAssistanceUrl: () => null }),
);
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarExpanded',
  () => ({ BrowserStatusBarExpanded: () => null }),
);
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarMinimized',
  () => ({ BrowserStatusBarMinimized: () => null }),
);
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen',
  () => ({ BrowserStatusBarFullscreen: () => null }),
);
const event = (taskId: string) => ({
  message_id: 'phone-1',
  timestamp: 'now',
  metadata: { task_id: taskId, toolName: 'phone' },
});
beforeEach(() => {
  fixture.expanded = true;
  fixture.fullscreen = false;
  fixture.messages = [];
});
describe('expanded browser phone entry', () => {
  it('opens the existing fullscreen once for the owned phone activity, without reopening on close', () => {
    const open = vi.fn();
    window.addEventListener('navi-open-browser', open);
    fixture.messages = [event('task-a')];
    const view = render(<BrowserStatusBar taskId="task-a" browserUrl="https://example.com" />);
    expect(open).toHaveBeenCalledOnce();
    expect((open.mock.calls[0][0] as CustomEvent).detail.taskId).toBe('task-a');
    fixture.fullscreen = true;
    view.rerender(<BrowserStatusBar taskId="task-a" browserUrl="https://example.com" />);
    fixture.fullscreen = false;
    view.rerender(<BrowserStatusBar taskId="task-a" browserUrl="https://example.com" />);
    expect(open).toHaveBeenCalledOnce();
    window.removeEventListener('navi-open-browser', open);
  });
  it('keeps collapsed and foreign task activity passive', () => {
    const open = vi.fn();
    window.addEventListener('navi-open-browser', open);
    fixture.messages = [event('foreign')];
    const view = render(<BrowserStatusBar taskId="task-a" browserUrl="https://example.com" />);
    expect(open).not.toHaveBeenCalled();
    fixture.expanded = false;
    fixture.messages = [event('task-a')];
    view.rerender(<BrowserStatusBar taskId="task-a" browserUrl="https://example.com" />);
    expect(open).not.toHaveBeenCalled();
    window.removeEventListener('navi-open-browser', open);
  });
});
