/** Delayed terminal work must belong to the currently selected agent. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalMessages } from '@/features/terminal/hooks/useTerminalMessages';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('terminal reconnect lifecycle', () => {
  it('coalesces focus and visibility events into one reconnect', () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    renderHook(() => useTerminalMessages([], 'agent-1', reconnect));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      vi.advanceTimersByTime(1000);
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('cancels pending reconnects across repeated agent switches and unmount', () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ agentId }) => useTerminalMessages([], agentId, reconnect),
      { initialProps: { agentId: 'agent-0' } },
    );
    for (let index = 1; index <= 50; index += 1) {
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      rerender({ agentId: `agent-${index}` });
    }
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(reconnect).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('drops a reconnect when the document becomes hidden before its deadline', () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const reconnect = vi.fn();
    renderHook(() => useTerminalMessages([], 'agent-1', reconnect));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    hidden.mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1000);
    });
    expect(reconnect).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1000);
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
