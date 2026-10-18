/** [slow POST] -> abort only request -> UNKNOWN stable ID -> status-only recovery -> fresh bounds. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePhoneAttention } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneAttention';
import { usePhoneOverlay } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneOverlay';

vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-user' }),
}));
const base = 'http://localhost:3001/api/iphone';
const lease = {
  id: 'lease-a',
  browserTaskId: 'task-a',
  agentId: 'agent-a',
  status: 'ACTIVE',
  controlOwner: 'user',
  revision: 1,
  queuePosition: null,
  queueDeadlineAt: null,
  leaseExpiresAt: null,
  attentionRequestId: null,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function abortable(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    }),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:timeout-frame');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('recovers a slow input by its one ID after the 15s request bound without replaying it', async () => {
  let postedId = '',
    inputCount = 0,
    statusReads = 0,
    cursor = 0;
  let recovered = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
    const url = String(input);
    if (url === `${base}/interactions/task-a`)
      return json({ lease, cursor, lastOperation: null, pendingOperation: null });
    if (url.endsWith('/frame'))
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      });
    if (url.endsWith('/operations')) {
      const command = JSON.parse(String(init.body));
      cursor++;
      if (command.operation === 'screen.bounds')
        return json({
          operation: {
            id: command.operationId,
            cursor,
            operation: command.operation,
            status: 'SUCCEEDED',
            result: { x: 40, y: 60, w: 430, h: 932 },
          },
        });
      postedId = command.operationId;
      inputCount++;
      return abortable(init.signal);
    }
    if (url === `${base}/leases/lease-a/operations/${postedId}`) {
      statusReads++;
      return json({
        operation: {
          id: postedId,
          cursor,
          operation: 'nav.home',
          status: recovered ? 'SUCCEEDED' : 'RUNNING',
          result: null,
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const hook = renderHook(() => usePhoneOverlay('task-a', 'phone-event', false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(hook.result.current.bounds).toEqual({ x: 40, y: 60, w: 430, h: 932 });
  let action: Promise<void>;
  act(() => {
    action = hook.result.current.input('nav.home', {});
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  await action;
  expect(inputCount).toBe(1);
  expect(hook.result.current.uncertain).toBe(true);
  expect(hook.result.current.busy).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(statusReads).toBeGreaterThan(0);
  recovered = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(hook.result.current.uncertain).toBe(false);
  expect(hook.result.current.bounds).not.toBeNull();
  expect(inputCount).toBe(1);
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/operations/${postedId}`)).length,
  ).toBeGreaterThan(0);
  hook.unmount();
});

it('clears stale frame/bounds after a hung frame then keeps the visible reader recoverable', async () => {
  let hang = false,
    frames = 0,
    reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
      const url = String(input);
      if (url.includes('/interactions/')) {
        reads++;
        return json({
          lease: { ...lease, controlOwner: 'agent' },
          cursor: 0,
          lastOperation: null,
          pendingOperation: null,
        });
      }
      if (url.endsWith('/frame')) {
        frames++;
        if (hang) return abortable(init.signal);
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error('Unexpected mutation');
    }),
  );
  const hook = renderHook(() => usePhoneOverlay('task-a', 'phone-event', true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(hook.result.current.frame).toBe('blob:timeout-frame');
  hang = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16000);
  });
  expect(hook.result.current.frame).toBeNull();
  expect(hook.result.current.bounds).toBeNull();
  expect(hook.result.current.error).toMatch(/unavailable/i);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:timeout-frame');
  const previous = reads;
  hang = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(reads).toBeGreaterThan(previous);
  expect(hook.result.current.frame).toBe('blob:timeout-frame');
  expect(frames).toBe(3);
  hook.unmount();
});

it('retries a transient first interaction read finitely and then shows the owned phone', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/interactions/')) {
        reads++;
        return reads === 1
          ? new Response('', { status: 503 })
          : json({
              lease: { ...lease, controlOwner: 'agent' },
              cursor: 0,
              lastOperation: null,
              pendingOperation: null,
            });
      }
      if (url.endsWith('/frame'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      throw new Error('Unexpected request');
    }),
  );
  const hook = renderHook(() => usePhoneOverlay('task-a', 'phone-event', true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(reads).toBe(2);
  expect(hook.result.current.visible).toBe(true);
  expect(hook.result.current.frame).toBe('blob:timeout-frame');
  hook.unmount();
});

it.each([403, 404])('does not retry a denied or missing task (%s)', async (status) => {
  const fetcher = vi.fn(async () => new Response('', { status }));
  vi.stubGlobal('fetch', fetcher);
  const hook = renderHook(() => usePhoneOverlay('task-a', 'phone-event', true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(hook.result.current.visible).toBe(false);
  hook.unmount();
});

it('exhausts bootstrap reads after three attempts without creating an idle poll', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const hook = renderHook(() => usePhoneOverlay('task-a', 'phone-event', true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(hook.result.current.error).toMatch(/unavailable/i);
  expect(hook.result.current.visible).toBe(false);
  hook.unmount();
});

it('keeps the active scope and pending user operation across new task phone events', async () => {
  let aborted = 0,
    postedId = '',
    posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
      const url = String(input);
      if (url.includes('/interactions/'))
        return json({ lease, cursor: 8, lastOperation: null, pendingOperation: null });
      if (url.endsWith('/frame'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      if (url.endsWith('/operations')) {
        const command = JSON.parse(String(init.body));
        if (command.operation === 'screen.bounds')
          return json({
            operation: {
              id: command.operationId,
              cursor: 8,
              operation: command.operation,
              status: 'SUCCEEDED',
              result: { x: 40, y: 60, w: 430, h: 932 },
            },
          });
        posts++;
        postedId = command.operationId;
        init.signal.addEventListener('abort', () => aborted++);
        return abortable(init.signal);
      }
      if (url.endsWith(`/operations/${postedId}`))
        return json({
          operation: {
            id: postedId,
            cursor: 9,
            operation: 'nav.home',
            status: 'SUCCEEDED',
            result: null,
          },
        });
      throw new Error('Unexpected request');
    }),
  );
  const hook = renderHook(({ trigger }) => usePhoneOverlay('task-a', trigger, false), {
    initialProps: { trigger: 'first-phone-event' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  let action: Promise<void>;
  act(() => {
    action = hook.result.current.input('nav.home', {});
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  hook.rerender({ trigger: 'agent-status-phone-event' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(aborted).toBe(0);
  expect(posts).toBe(1);
  expect(hook.result.current.frame).toBe('blob:timeout-frame');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16000);
  });
  await action;
  expect(posts).toBe(1);
  expect(hook.result.current.uncertain).toBe(false);
  hook.unmount();
});

it('uses a new phone event to wake a terminal task scope without polling while dormant', async () => {
  let status = 'RELEASED',
    reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/interactions/')) {
        reads++;
        return json({
          lease: { ...lease, status, controlOwner: 'agent' },
          cursor: 0,
          lastOperation: null,
          pendingOperation: null,
        });
      }
      if (url.endsWith('/frame'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      throw new Error('Unexpected request');
    }),
  );
  const hook = renderHook(({ trigger }) => usePhoneOverlay('task-a', trigger, true), {
    initialProps: { trigger: 'old-phone-event' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(reads).toBe(1);
  expect(hook.result.current.visible).toBe(false);
  status = 'ACTIVE';
  hook.rerender({ trigger: 'new-phone-event' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(reads).toBe(2);
  expect(hook.result.current.visible).toBe(true);
  hook.unmount();
});

it('keeps dormant phone hooks free of requests, visibility listeners and timers', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const listen = vi.spyOn(document, 'addEventListener');
  const hook = renderHook(() => usePhoneOverlay('ordinary-browser', '', false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(listen.mock.calls.filter(([name]) => name === 'visibilitychange')).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  expect(hook.result.current.visible).toBe(false);
  hook.unmount();
});

it('keeps absent native attention free of requests, visibility listeners and timers', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const listen = vi.spyOn(document, 'addEventListener');
  const hook = renderHook(() => usePhoneAttention('ordinary-browser', 'agent-a', [], false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(listen.mock.calls.filter(([name]) => name === 'visibilitychange')).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  expect(hook.result.current.id).toBe('');
  hook.unmount();
});

it('does not start a phone read when a dormant tab becomes hidden before activation', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const hook = renderHook(({ trigger }) => usePhoneOverlay('task-a', trigger, false), {
    initialProps: { trigger: '' },
  });
  visibility.mockReturnValue('hidden');
  hook.rerender({ trigger: 'phone-event' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  hook.unmount();
});
