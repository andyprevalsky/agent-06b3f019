/**
 * Blackbox tests for BrowserCursorOverlay realtime cursor routing.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@/lib/api';

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
});
