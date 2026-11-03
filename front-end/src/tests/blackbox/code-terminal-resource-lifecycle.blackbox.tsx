/** Terminal instances, fit observers, sockets and retries have one mounted owner. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useClaudeCodeWebSocket,
  useTerminalManager,
} from '@/features/terminal-component-group/components/claudeCodeChip.terminal';

const mocks = vi.hoisted(() => ({
  terminals: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  fits: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    constructor() {
      mocks.terminals.push(this);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    constructor() {
      mocks.fits.push(this);
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.terminals.length = 0;
  mocks.fits.length = 0;
});

function socketHarness() {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn(() => {
      this.readyState = 3;
      this.onclose?.();
    });
    constructor(readonly url: string) {
      sockets.push(this);
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  const outputBufferRef = { current: '' };
  const args = {
    wsUrl: 'wss://terminal/first',
    terminalRef: { current: null },
    outputBufferRef,
    isCompletedRef: { current: false },
    shouldClose: false,
    onStateChange: vi.fn(),
  };
  return { sockets, args, outputBufferRef };
}

describe('code terminal resource lifecycle', () => {
  it('retries a natural disconnect and still delivers live state and terminal bytes', () => {
    vi.useFakeTimers();
    const { sockets, args, outputBufferRef } = socketHarness();
    const { unmount } = renderHook(() => useClaudeCodeWebSocket(args));
    act(() => {
      sockets[0].onclose?.();
      vi.advanceTimersByTime(100);
      sockets[1].onopen?.();
      sockets[1].onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'stdout', data: 'live output' }),
        }),
      );
    });
    expect(sockets).toHaveLength(2);
    expect(args.onStateChange).toHaveBeenLastCalledWith('live');
    expect(outputBufferRef.current).toContain('live output');
    unmount();
  });

  it('disposes its terminal and cancels pending fit work on unmount', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { result, unmount } = renderHook(() => useTerminalManager());
    act(() => {
      result.current.mount(document.createElement('div'));
    });
    unmount();
    expect(mocks.terminals[0].dispose).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(1);
    frames[0](0);
    expect(mocks.fits[0].fit).not.toHaveBeenCalled();
  });

  it('makes each mount cleanup idempotent and preserves a replacement terminal', () => {
    const { result, unmount } = renderHook(() => useTerminalManager());
    const firstCleanup = result.current.mount(document.createElement('div'));
    const secondCleanup = result.current.mount(document.createElement('div'));
    firstCleanup();
    expect(mocks.terminals[0].dispose).toHaveBeenCalledTimes(1);
    expect(result.current.terminalRef.current).toBe(mocks.terminals[1]);
    secondCleanup();
    expect(mocks.terminals[1].dispose).toHaveBeenCalledTimes(1);
    expect(result.current.terminalRef.current).toBeNull();
    unmount();
    expect(mocks.terminals[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after unmount even when close dispatches synchronously', () => {
    vi.useFakeTimers();
    const { sockets, args } = socketHarness();
    const { unmount } = renderHook(() => useClaudeCodeWebSocket(args));
    unmount();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].onclose).toBeNull();
  });

  it('cancels a pending retry on URL replacement and ignores old socket messages', () => {
    vi.useFakeTimers();
    const { sockets, args, outputBufferRef } = socketHarness();
    const { rerender } = renderHook(({ wsUrl }) => useClaudeCodeWebSocket({ ...args, wsUrl }), {
      initialProps: { wsUrl: args.wsUrl },
    });
    const staleMessage = sockets[0].onmessage!;
    act(() => {
      sockets[0].onclose?.();
    });
    rerender({ wsUrl: 'wss://terminal/second' });
    act(() => {
      vi.advanceTimersByTime(2000);
      staleMessage(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'stdout', data: 'stale output' }),
        }),
      );
    });
    expect(sockets).toHaveLength(2);
    expect(outputBufferRef.current).toBe('');
    expect(sockets[1].url).toBe('wss://terminal/second');
  });

  it('closes a still-connecting socket when the session becomes completed', () => {
    const { sockets, args } = socketHarness();
    const { rerender } = renderHook(
      ({ shouldClose }) => useClaudeCodeWebSocket({ ...args, shouldClose }),
      {
        initialProps: { shouldClose: false },
      },
    );
    rerender({ shouldClose: true });
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets[0].onclose).toBeNull();
  });
});
