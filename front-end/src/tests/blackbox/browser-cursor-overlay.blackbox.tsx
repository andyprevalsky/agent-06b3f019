/**
 * Blackbox tests for BrowserCursorOverlay realtime cursor routing.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@/lib/api';
import { server } from './msw/server';

const realtimeMocks = vi.hoisted(() => ({
  subscribeToChannel: vi.fn(),
  unsubscribe: vi.fn(),
  extractRecord: vi.fn((wrapper: unknown) => {
    return (wrapper as { payload?: { record?: unknown } }).payload?.record ?? null;
  }),
}));

vi.mock('@/lib/realtime', () => ({
  subscribeToChannel: realtimeMocks.subscribeToChannel,
  unsubscribe: realtimeMocks.unsubscribe,
  extractRecord: realtimeMocks.extractRecord,
}));

import BrowserCursorOverlay from '@/features/terminal-component-group/components/BrowserCursorOverlay';
import { useRefreshedAuthAssistanceUrl } from '@/features/terminal-component-group/components/browser-status-bar/useRefreshedAuthAssistanceUrl';
import type { PendingAuthAssistance } from '@/features/terminal-component-group/components/browser-status-bar/types';

const API_BASE = 'http://localhost:3001/api';

function makeMessageWithCoords(x: number, y: number): Message {
  return {
    message_id: 'message-with-coords',
    timestamp: '2026-05-29T12:00:00Z',
    text: 'Clicked',
    role: 'TOOL',
    metadata: {
      task_id: 'task-1',
      auxiliary: { coordinates: { x, y } },
    },
  };
}

describe('BrowserCursorOverlay realtime stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realtimeMocks.subscribeToChannel.mockResolvedValue({ topic: 'agent:agent-1' });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1288,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 891,
    });
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ access_token: 'test-token', user: { id: 'test-user' } }),
    );
  });

  it('subscribes to BROWSER_CURSOR and moves the stitched cursor from live samples', async () => {
    render(<BrowserCursorOverlay agentId="agent-1" taskId="task-1" messages={[]} />);

    await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalled());
    const handlers = realtimeMocks.subscribeToChannel.mock.calls[0][1] as Record<
      string,
      (payload: unknown) => void
    >;

    act(() => {
      handlers.BROWSER_CURSOR({
        payload: {
          record: {
            agentId: 'agent-1',
            taskId: 'task-1',
            x: 320,
            y: 200,
            sequence: 1,
          },
        },
      });
    });

    const cursor = screen.getByTestId('browser-cursor');
    expect(cursor).toHaveStyle({ left: '324px', top: '291px' });
  });

  it('interpolates between consecutive realtime cursor samples instead of snapping', async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);
    const performanceNowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

    try {
      render(<BrowserCursorOverlay agentId="agent-1" taskId="task-1" messages={[]} />);

      await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalled());
      const handlers = realtimeMocks.subscribeToChannel.mock.calls[0][1] as Record<
        string,
        (payload: unknown) => void
      >;

      act(() => {
        handlers.BROWSER_CURSOR({
          payload: {
            record: {
              agentId: 'agent-1',
              taskId: 'task-1',
              x: 100,
              y: 100,
              sequence: 1,
              timestampMs: 1000,
            },
          },
        });
      });

      const cursor = screen.getByTestId('browser-cursor');
      expect(cursor).toHaveStyle({ left: '104px', top: '191px' });

      act(() => {
        handlers.BROWSER_CURSOR({
          payload: {
            record: {
              agentId: 'agent-1',
              taskId: 'task-1',
              x: 500,
              y: 300,
              sequence: 2,
              timestampMs: 1070,
            },
          },
        });
      });

      expect(cursor).toHaveStyle({ left: '104px', top: '191px' });

      act(() => {
        rafCallbacks.shift()?.(1035);
      });

      expect(cursor).toHaveStyle({ left: '304px', top: '291px' });

      act(() => {
        rafCallbacks.shift()?.(1070);
      });

      expect(cursor).toHaveStyle({ left: '504px', top: '391px' });
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
      performanceNowSpy.mockRestore();
    }
  });

  it('keeps saved message coordinates as a fallback when realtime is unavailable', () => {
    render(
      <BrowserCursorOverlay
        agentId={null}
        taskId="task-1"
        messages={[makeMessageWithCoords(100, 50)]}
      />,
    );

    const cursor = screen.getByTestId('browser-cursor');
    expect(cursor).toHaveStyle({ left: '104px', top: '141px' });
    expect(realtimeMocks.subscribeToChannel).not.toHaveBeenCalled();
  });

  it('cannot apply a queued cursor callback after switching agents', async () => {
    const view = render(<BrowserCursorOverlay agentId="agent-a" taskId="task-1" messages={[]} />);
    await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalledTimes(1));
    const staleHandlers = realtimeMocks.subscribeToChannel.mock.calls[0][1] as Record<
      string,
      (payload: unknown) => void
    >;

    view.rerender(<BrowserCursorOverlay agentId="agent-b" taskId="task-1" messages={[]} />);
    await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalledTimes(2));
    act(() => {
      staleHandlers.BROWSER_CURSOR({
        payload: {
          record: { agentId: 'agent-a', taskId: 'task-1', x: 10, y: 20, sequence: 2 },
        },
      });
    });

    expect(screen.getByTestId('browser-cursor')).toHaveStyle({ left: '644px', top: '491px' });
  });

  it('rejects a cursor payload whose agent identity differs from its channel', async () => {
    render(<BrowserCursorOverlay agentId="agent-1" taskId="task-1" messages={[]} />);
    await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalled());
    const handlers = realtimeMocks.subscribeToChannel.mock.calls[0][1] as Record<
      string,
      (payload: unknown) => void
    >;

    act(() => {
      handlers.BROWSER_CURSOR({
        payload: {
          record: { agentId: 'other-agent', taskId: 'task-1', x: 10, y: 20, sequence: 1 },
        },
      });
    });

    expect(screen.getByTestId('browser-cursor')).toHaveStyle({ left: '644px', top: '491px' });
  });
});

describe('browser auth URL isolation', () => {
  it('never renders the previous request URL during a browser-agent switch', async () => {
    let finishAgentA!: () => void;
    const agentACanFinish = new Promise<void>((resolve) => {
      finishAgentA = resolve;
    });
    server.use(
      http.post(`${API_BASE}/auth-assistance/:requestId/refresh-session`, async ({ params }) => {
        const requestId = String(params.requestId);
        if (requestId === 'request-a') await agentACanFinish;
        return HttpResponse.json({ liveViewUrl: `https://${requestId}.example/live` });
      }),
    );
    const requestA: PendingAuthAssistance = {
      requestId: 'request-a',
      request: 'Authenticate A',
      liveViewUrl: 'https://agent-a.example/live',
    };
    const requestB: PendingAuthAssistance = {
      requestId: 'request-b',
      request: 'Authenticate B',
      liveViewUrl: 'https://agent-b.example/live',
    };
    const rendered: Array<{ requestId: string; url: string | null }> = [];
    function UrlProbe({ request }: { request: PendingAuthAssistance }) {
      const url = useRefreshedAuthAssistanceUrl(request);
      rendered.push({ requestId: request.requestId, url });
      return <output data-testid="auth-url">{url}</output>;
    }

    const view = render(<UrlProbe request={requestA} />);
    view.rerender(<UrlProbe request={requestB} />);

    expect(rendered.filter((entry) => entry.requestId === 'request-b')).not.toContainEqual({
      requestId: 'request-b',
      url: requestA.liveViewUrl,
    });
    expect(screen.getByTestId('auth-url')).toHaveTextContent('agent-b');
    finishAgentA();
    await waitFor(() => expect(screen.getByTestId('auth-url')).toHaveTextContent('request-b'));
  });
});
