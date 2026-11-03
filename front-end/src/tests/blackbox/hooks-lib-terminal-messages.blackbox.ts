import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useTerminalMessages } from '@/features/terminal/hooks/useTerminalMessages';

type TerminalMessages = Parameters<typeof useTerminalMessages>[0];
type WritableEndRef = { current: HTMLDivElement | null };

describe('useTerminalMessages', () => {
  it('checks long completed trajectories in linear work and still scrolls near the bottom', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 499;
    const end = document.createElement('div');
    viewport.appendChild(end);
    let metadataReads = 0;
    const messages: TerminalMessages = Array.from({ length: 2000 }, (_, index) => ({
      message_id: `message-${index}`,
      timestamp: '2026-11-02T00:00:00Z',
      role: 'TOOL',
      text: '',
      get metadata() {
        metadataReads += 1;
        return {
          task_id: `task-${Math.floor(index / 2)}`,
          action_type: index % 2 ? ('task_complete' as const) : ('wait' as const),
        };
      },
    }));
    const { result, rerender, unmount } = renderHook(
      ({ m }: { m: TerminalMessages }) => useTerminalMessages(m, 'agent-a', () => {}),
      { initialProps: { m: [] } },
    );
    try {
      (result.current.messagesEndRef as WritableEndRef).current = end;
      rerender({ m: messages });
      expect(viewport.scrollTop).toBe(1000);
      expect(metadataReads).toBeLessThan(messages.length * 5);
    } finally {
      unmount();
    }
  });
  it('wires visibility + focus listeners, attached/detached around mount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const winAddSpy = vi.spyOn(window, 'addEventListener');
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener');
    const force = vi.fn();
    const { unmount } = renderHook(() => useTerminalMessages([], 'agent-1', force));
    expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(winAddSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(winRemoveSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
    winAddSpy.mockRestore();
    winRemoveSpy.mockRestore();
  });

  it('visibility change → forceResubscribe after timeout; focus → forceResubscribe after timeout', () => {
    vi.useFakeTimers();
    const force = vi.fn();
    renderHook(() => useTerminalMessages([], 'agent-1', force));
    // simulate becoming visible
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1200);
    expect(force).toHaveBeenCalled();

    force.mockReset();
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(600);
    expect(force).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('markInitialLoad is stable across renders', () => {
    const { result, rerender } = renderHook(
      ({ m }: { m: TerminalMessages }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    const first = result.current.markInitialLoad;
    rerender({ m: [{ message_id: 'a', timestamp: 't', metadata: {} }] as never });
    expect(result.current.markInitialLoad).toBe(first);
  });

  it('auto-scroll path: exits early when last message is a browser_url', () => {
    // Build a DOM: viewport > endDiv ; the ref inherits the attachment via
    // .closest('[data-radix-scroll-area-viewport]').
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 10000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 0;
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const { result, rerender } = renderHook(
      ({ m }: { m: TerminalMessages }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    // Attach ref to our DOM node
    (result.current.messagesEndRef as WritableEndRef).current = endDiv;

    // Last message has a browser_url → should early-return, no scroll
    rerender({ m: [{ metadata: { browser_url: 'https://x' } }] as never });
    expect(viewport.scrollTop).toBe(0);

    document.body.removeChild(viewport);
  });

  it('auto-scroll path: skips when task is still active', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 10000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 0;
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const { result, rerender } = renderHook(
      ({ m }: { m: TerminalMessages }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    (result.current.messagesEndRef as WritableEndRef).current = endDiv;
    rerender({
      m: [
        { metadata: { task_id: 't1', action_type: 'system' } },
        { metadata: { action_type: 'progress' } },
      ] as never,
    });
    expect(viewport.scrollTop).toBe(0); // active browser → no scroll
    document.body.removeChild(viewport);
  });

  it('auto-scroll path: scrolls when user is near bottom', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 499; // distanceFromBottom = 1000 - 499 - 500 = 1 < AUTO_SCROLL_THRESHOLD
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const { result, rerender } = renderHook(
      ({ m }: { m: TerminalMessages }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    (result.current.messagesEndRef as WritableEndRef).current = endDiv;
    rerender({ m: [{ metadata: {} }] as never });
    expect(viewport.scrollTop).toBe(1000);
    document.body.removeChild(viewport);
  });

  it('auto-scroll path: initial load uses rAF to scroll to bottom', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 0;
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const rafSpy = vi
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });

    const { result, rerender } = renderHook(
      ({ m }: { m: TerminalMessages }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    (result.current.messagesEndRef as WritableEndRef).current = endDiv;
    act(() => {
      result.current.markInitialLoad();
    });
    rerender({ m: [{ metadata: {} }] as never });
    expect(viewport.scrollTop).toBe(2000);
    rafSpy.mockRestore();
    document.body.removeChild(viewport);
  });
});
