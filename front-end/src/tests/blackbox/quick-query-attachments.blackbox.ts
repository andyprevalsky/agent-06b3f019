/**
 * Blackbox: quick-launcher payloads with file attachments.
 *
 * The launcher window holds local File bytes and forwards them over IPC.
 * useQuickQuery (main window) must upload those bytes, then createAgent with
 * the resulting file pointers.
 *
 * Also covers cold start: the launcher can re-create the main window for a
 * submit, so the payload may arrive before useQuickQuery has mounted or while
 * auth is still resolving. It must launch once the consumer is ready.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useQuickQuery, type QuickQueryDeps } from '@/features/terminal/hooks/useQuickQuery';
import {
  QUICK_QUERY_LAUNCH_WINDOW_MS,
  QUICK_QUERY_MAX_HELD,
  dispatchQuickQueryEvent,
  goalFromQuickLauncherPayload,
  subscribeQuickQuery,
  type QuickLauncherPayload,
} from '@/lib/quickQuery';

const createAgent = vi.fn(async (_request: unknown) => ({ agent_id: 'agent-qq-1' }));
const uploadAttachment = vi.fn(async (file: File) => ({
  id: `fp-${file.name}`,
  storage_path: `attachments/u/${file.name}`,
  original_filename: file.name,
  mime_type: file.type || 'application/octet-stream',
  size_bytes: file.size,
  created_at: new Date().toISOString(),
}));

vi.mock('@/features/terminal/api', () => ({
  createAgent: (request: unknown) => createAgent(request),
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...(args as [File])),
}));

function makeDeps(overrides: Partial<QuickQueryDeps> = {}): QuickQueryDeps {
  return {
    selectedModel: 'rose-1-flash',
    canSubmitGoals: true,
    authReady: true,
    messageInput: '',
    clientSource: 'MAC_APP',
    pendingPriceLimitCents: 500,
    setCurrentView: vi.fn(),
    setMessageInput: vi.fn(),
    setIsSendingMessage: vi.fn(),
    setIsLoadingNetwork: vi.fn(),
    setLoginModalOpen: vi.fn(),
    setSelectedAgentIdContext: vi.fn(),
    loadAgents: vi.fn(async () => undefined),
    toast: vi.fn() as QuickQueryDeps['toast'],
    ...overrides,
  };
}

function attachment(name: string, contents: string, mimeType = 'text/plain') {
  const encoded = new TextEncoder().encode(contents);
  return {
    name,
    mimeType,
    size: encoded.byteLength,
    data: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
  };
}

describe('quick-query attachments', () => {
  beforeEach(() => {
    createAgent.mockClear();
    uploadAttachment.mockClear();
  });

  it('goalFromQuickLauncherPayload prefers typed query, else filenames', () => {
    expect(
      goalFromQuickLauncherPayload({ query: ' do it ', submittedAt: 1, attachments: [] }),
    ).toBe('do it');
    expect(
      goalFromQuickLauncherPayload({
        query: '  ',
        submittedAt: 1,
        attachments: [attachment('a.txt', 'x')],
      }),
    ).toBe('Process a.txt');
    expect(
      goalFromQuickLauncherPayload({
        query: '',
        submittedAt: 1,
        attachments: [attachment('a.txt', 'x'), attachment('b.txt', 'y')],
      }),
    ).toBe('Process 2 attached files');
  });

  it('uploads attachments then createAgent with file pointers', async () => {
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));

    const payload: QuickLauncherPayload = {
      query: 'summarize this',
      submittedAt: Date.now(),
      attachments: [attachment('notes.txt', 'hello world')],
    };

    await act(async () => {
      dispatchQuickQueryEvent(payload);
    });

    await waitFor(() => {
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(createAgent).toHaveBeenCalledTimes(1);
    });

    const uploaded = uploadAttachment.mock.calls[0]?.[0] as File;
    expect(uploaded.name).toBe('notes.txt');
    expect(uploaded.type).toBe('text/plain');

    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      goal: 'summarize this',
      source: 'MAC_APP',
      attachments: [
        expect.objectContaining({
          id: 'fp-notes.txt',
          original_filename: 'notes.txt',
        }),
      ],
    });
    expect(deps.setSelectedAgentIdContext).toHaveBeenCalledWith('agent-qq-1');
    unmount();
  });

  it('marks only the launcher auto-screenshot pointer as auto_captured', async () => {
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));

    await act(async () => {
      dispatchQuickQueryEvent({
        query: 'what is this error',
        submittedAt: Date.now(),
        attachments: [
          { ...attachment('Screenshot.png', 'png', 'image/png'), autoCaptured: true },
          attachment('notes.txt', 'hello world'),
        ],
      });
    });

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledTimes(1);
    });
    const request = createAgent.mock.calls[0]?.[0] as { attachments: Record<string, unknown>[] };
    expect(request.attachments[0]).toMatchObject({
      original_filename: 'Screenshot.png',
      auto_captured: true,
    });
    expect(request.attachments[1]?.original_filename).toBe('notes.txt');
    expect(request.attachments[1]).not.toHaveProperty('auto_captured');
    unmount();
  });

  it('creates an agent from attachments-only payloads', async () => {
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));

    await act(async () => {
      dispatchQuickQueryEvent({
        query: '',
        submittedAt: Date.now(),
        attachments: [attachment('solo.pdf', '%PDF', 'application/pdf')],
      });
    });

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledTimes(1);
    });
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      goal: 'Process solo.pdf',
      attachments: [expect.objectContaining({ original_filename: 'solo.pdf' })],
    });
    unmount();
  });

  it('does not createAgent when upload fails', async () => {
    uploadAttachment.mockRejectedValueOnce(new Error('network down'));
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));

    await act(async () => {
      dispatchQuickQueryEvent({
        query: 'hi',
        submittedAt: Date.now(),
        attachments: [attachment('x.txt', 'x')],
      });
    });

    await waitFor(() => {
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
    });
    expect(createAgent).not.toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Attachment upload failed',
        variant: 'destructive',
      }),
    );
    unmount();
  });

  it('empty query with no attachments remains a no-op', async () => {
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));

    await act(async () => {
      dispatchQuickQueryEvent({ query: '   ', submittedAt: Date.now() });
    });

    expect(createAgent).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(deps.setCurrentView).not.toHaveBeenCalled();
    unmount();
  });
});

describe('quick-query cold start', () => {
  beforeEach(() => {
    createAgent.mockClear();
    uploadAttachment.mockClear();
  });

  it('launches a submit that was dispatched before the hook mounted, exactly once', async () => {
    act(() => {
      dispatchQuickQueryEvent({ query: 'sent before terminal mounted', submittedAt: Date.now() });
    });
    expect(createAgent).not.toHaveBeenCalled();

    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({ goal: 'sent before terminal mounted' });
    await waitFor(() => expect(deps.setSelectedAgentIdContext).toHaveBeenCalledWith('agent-qq-1'));
    expect(deps.setLoginModalOpen).not.toHaveBeenCalled();
    unmount();

    const remount = renderHook(() => useQuickQuery(makeDeps()));
    await act(async () => {
      await Promise.resolve();
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
    remount.unmount();
  });

  it('holds a submit while auth is resolving, then launches it as the signed-in user', async () => {
    const pending = makeDeps({ authReady: false, canSubmitGoals: false });
    const { rerender, unmount } = renderHook(
      ({ deps }: { deps: QuickQueryDeps }) => useQuickQuery(deps),
      { initialProps: { deps: pending } },
    );

    await act(async () => {
      dispatchQuickQueryEvent({ query: 'sent while auth loads', submittedAt: Date.now() });
    });
    // Not judged yet: no login prompt, no agent.
    expect(pending.setLoginModalOpen).not.toHaveBeenCalled();
    expect(pending.toast).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();

    const ready = makeDeps({ authReady: true, canSubmitGoals: true });
    rerender({ deps: ready });

    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({ goal: 'sent while auth loads' });
    expect(ready.setLoginModalOpen).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps receiving live submits after auth resolves', async () => {
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));

    await act(async () => {
      dispatchQuickQueryEvent({ query: 'live one', submittedAt: Date.now() });
    });
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
    unmount();

    // After unmount nothing is listening: the next submit is held, not lost.
    act(() => {
      dispatchQuickQueryEvent({ query: 'held after unmount', submittedAt: Date.now() });
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
    const remount = renderHook(() => useQuickQuery(makeDeps()));
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(2));
    expect(createAgent.mock.calls[1]?.[0]).toMatchObject({ goal: 'held after unmount' });
    remount.unmount();
  });

  // Two submits held during one cold start replay together. Started at once,
  // the first to finish cleared the input and the sending state under the other.
  it('launches held submits one at a time, in submit order', async () => {
    let finishFirst: (() => void) | null = null;
    createAgent.mockImplementationOnce(
      () =>
        new Promise<{ agent_id: string }>((resolve) => {
          finishFirst = () => resolve({ agent_id: 'agent-first' });
        }),
    );
    act(() => {
      dispatchQuickQueryEvent({ query: 'first held', submittedAt: Date.now() });
      dispatchQuickQueryEvent({ query: 'second held', submittedAt: Date.now() });
    });

    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({ goal: 'first held' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(deps.setIsSendingMessage).not.toHaveBeenCalledWith(false);

    await act(async () => {
      finishFirst?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(2));
    expect(createAgent.mock.calls[1]?.[0]).toMatchObject({ goal: 'second held' });
    unmount();
  });

  it('keeps every expired submit in the input, not only the last one', async () => {
    const stale = Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS - 1;
    act(() => {
      dispatchQuickQueryEvent({ query: 'first expired', submittedAt: stale });
      dispatchQuickQueryEvent({ query: 'second expired', submittedAt: stale });
    });

    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await act(async () => {
      await Promise.resolve();
    });

    expect(createAgent).not.toHaveBeenCalled();
    expect(vi.mocked(deps.setMessageInput).mock.lastCall?.[0]).toBe(
      'first expired\n\nsecond expired',
    );
    unmount();
  });

  // An expired draft is text the user has not sent. A fresh submit drained in
  // the same pass used to prefill and then clear the input over it.
  it('keeps an expired submit in the input when a fresh one launches in the same drain', async () => {
    const stale = Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS - 1;
    act(() => {
      dispatchQuickQueryEvent({ query: 'expired draft', submittedAt: stale });
      dispatchQuickQueryEvent({ query: 'fresh launch', submittedAt: Date.now() });
    });

    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await waitFor(() => expect(deps.setSelectedAgentIdContext).toHaveBeenCalled());

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({ goal: 'fresh launch' });
    expect(vi.mocked(deps.setMessageInput).mock.calls).toEqual([['expired draft']]);
    unmount();
  });

  it('lets a launch use the input again once the user has sent the expired draft', async () => {
    const stale = Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS - 1;
    act(() => {
      dispatchQuickQueryEvent({ query: 'expired draft', submittedAt: stale });
    });

    const deps = makeDeps();
    const { rerender, unmount } = renderHook((props: QuickQueryDeps) => useQuickQuery(props), {
      initialProps: deps,
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ ...deps, messageInput: 'expired draft' });
    rerender({ ...deps, messageInput: '' });

    await act(async () => {
      dispatchQuickQueryEvent({ query: 'later launch', submittedAt: Date.now() });
    });
    await waitFor(() => expect(deps.setSelectedAgentIdContext).toHaveBeenCalled());

    expect(vi.mocked(deps.setMessageInput).mock.calls).toEqual([
      ['expired draft'],
      ['later launch'],
      [''],
    ]);
    unmount();
  });

  it('adds a later expired submit to drafts that are still unsent in the input', async () => {
    const stale = Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS - 1;
    act(() => {
      dispatchQuickQueryEvent({ query: 'first expired', submittedAt: stale });
    });
    const deps = makeDeps();
    const { rerender, unmount } = renderHook((props: QuickQueryDeps) => useQuickQuery(props), {
      initialProps: deps,
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ ...deps, messageInput: 'first expired' });

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    await act(async () => {
      dispatchQuickQueryEvent({ query: 'later expired', submittedAt: stale });
    });
    clock.mockRestore();

    expect(vi.mocked(deps.setMessageInput).mock.lastCall?.[0]).toBe(
      'first expired\n\nlater expired',
    );
    unmount();
  });

  // No agent is launched more than the launch window after its submit, even
  // when the wait was for the launch ahead of it. Its text is kept instead.
  it('keeps a submit as a draft when its turn comes after the launch window', async () => {
    let finishFirst: (() => void) | null = null;
    createAgent.mockImplementationOnce(
      () =>
        new Promise<{ agent_id: string }>((resolve) => {
          finishFirst = () => resolve({ agent_id: 'agent-slow' });
        }),
    );
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    const submittedAt = Date.now();
    await act(async () => {
      dispatchQuickQueryEvent({ query: 'slow first', submittedAt });
      dispatchQuickQueryEvent({ query: 'right behind', submittedAt });
    });
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));

    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(submittedAt + QUICK_QUERY_LAUNCH_WINDOW_MS + 5_000);
    await act(async () => {
      finishFirst?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(vi.mocked(deps.setMessageInput).mock.lastCall?.[0]).toBe('right behind'),
    );
    clock.mockRestore();

    expect(createAgent).toHaveBeenCalledTimes(1);
    unmount();
  });

  // A launch that does not happen leaves its goal for the user to send. The
  // next queued submit used to prefill over it, losing the earlier submit.
  it('keeps both goals in the input when two submits hit the sign-in gate', async () => {
    const deps = makeDeps({ canSubmitGoals: false });
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await act(async () => {
      dispatchQuickQueryEvent({ query: 'first goal', submittedAt: Date.now() });
      dispatchQuickQueryEvent({ query: 'second goal', submittedAt: Date.now() });
    });
    await waitFor(() => expect(deps.setLoginModalOpen).toHaveBeenCalledTimes(2));

    expect(createAgent).not.toHaveBeenCalled();
    expect(vi.mocked(deps.setMessageInput).mock.calls).toEqual([
      ['first goal'],
      ['first goal\n\nsecond goal'],
    ]);
    unmount();
  });

  it('keeps a failed launch goal in the input while the next submit launches', async () => {
    createAgent.mockRejectedValueOnce(new Error('request failed'));
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await act(async () => {
      dispatchQuickQueryEvent({ query: 'fails to launch', submittedAt: Date.now() });
      dispatchQuickQueryEvent({ query: 'launches fine', submittedAt: Date.now() });
    });
    await waitFor(() => expect(deps.setSelectedAgentIdContext).toHaveBeenCalled());

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.setMessageInput).mock.calls).toEqual([['fails to launch']]);
    unmount();
  });

  // Launching an agent costs money. A submit that sat held (signed out, a
  // window that never loaded) must not start one long after it was asked for.
  it('shows a submit that waited past the launch window instead of launching it', async () => {
    act(() => {
      dispatchQuickQueryEvent({
        query: '  book the dentist  ',
        submittedAt: Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS - 1,
      });
    });

    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await act(async () => {
      await Promise.resolve();
    });

    expect(createAgent).not.toHaveBeenCalled();
    expect(deps.setCurrentView).toHaveBeenCalledWith('agents');
    expect(deps.setMessageInput).toHaveBeenCalledWith('book the dentist');
    expect(deps.toast).toHaveBeenCalledWith({
      title: 'Quick launch was not sent',
      description: 'Rose took too long to open. Your message is in the input.',
    });
    unmount();
  });

  it('still launches a submit held for just under the launch window', async () => {
    act(() => {
      dispatchQuickQueryEvent({
        query: 'slow but fresh',
        submittedAt: Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS + 5_000,
      });
    });

    const { unmount } = renderHook(() => useQuickQuery(makeDeps()));
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({ goal: 'slow but fresh' });
    unmount();
  });

  it('says the files were dropped when an expired submit carried text and attachments', async () => {
    act(() => {
      dispatchQuickQueryEvent({
        query: 'summarize this pdf',
        submittedAt: Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS - 1,
        attachments: [attachment('report.pdf', 'pdf bytes', 'application/pdf')],
      });
    });

    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await act(async () => {
      await Promise.resolve();
    });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(deps.setMessageInput).toHaveBeenCalledWith('summarize this pdf');
    expect(deps.toast).toHaveBeenCalledWith({
      title: 'Quick launch was not sent',
      description:
        'Rose took too long to open. Your message is in the input; attach your files again before sending.',
    });
    unmount();
  });

  it('asks for files again when an expired submit carried only attachments', async () => {
    act(() => {
      dispatchQuickQueryEvent({
        query: '',
        submittedAt: Date.now() - QUICK_QUERY_LAUNCH_WINDOW_MS - 1,
        attachments: [attachment('notes.txt', 'hello world')],
      });
    });

    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));
    await act(async () => {
      await Promise.resolve();
    });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(deps.setMessageInput).not.toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledWith({
      title: 'Quick launch was not sent',
      description: 'Rose took too long to open. Attach your files again to send them.',
    });
    unmount();
  });
});

describe('quick-query hold queue', () => {
  it('bounds held submits and reports the one it lets go', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let n = 0; n <= QUICK_QUERY_MAX_HELD; n += 1) {
      dispatchQuickQueryEvent({ query: `held ${n}`, submittedAt: n });
    }

    const received: string[] = [];
    const unsubscribe = subscribeQuickQuery((payload) => received.push(payload.query));
    expect(received).toHaveLength(QUICK_QUERY_MAX_HELD);
    expect(received[0]).toBe('held 1');
    expect(received[received.length - 1]).toBe(`held ${QUICK_QUERY_MAX_HELD}`);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    unsubscribe();
  });

  // The desktop main process keeps a submit until it is claimed. Claiming while
  // nothing can act on it would strand the query in a renderer that may reload.
  it('claims a held submit only once a consumer is ready, and acts only if the claim is granted', async () => {
    const granted = vi.fn(() => Promise.resolve(true));
    const refused = vi.fn(() => Promise.resolve(false));
    const failing = vi.fn(() => Promise.reject(new Error('ipc closed')));
    dispatchQuickQueryEvent({ query: 'granted', submittedAt: 1 }, granted);
    dispatchQuickQueryEvent({ query: 'refused', submittedAt: 2 }, refused);
    dispatchQuickQueryEvent({ query: 'failing', submittedAt: 3 }, failing);
    await Promise.resolve();
    expect(granted).not.toHaveBeenCalled();

    const received: string[] = [];
    const unsubscribe = subscribeQuickQuery((payload) => received.push(payload.query));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(received).toEqual(['granted']);
    expect(granted).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  // A submit waiting behind a slow launch must stay with the main process: once
  // claimed it exists only in this renderer, and a reload or close would lose it.
  it('claims the next submit only after the previous consumer work settles', async () => {
    let finishFirst: (() => void) | null = null;
    const firstClaim = vi.fn(() => Promise.resolve(true));
    const secondClaim = vi.fn(() => Promise.resolve(true));
    const received: string[] = [];
    const unsubscribe = subscribeQuickQuery((payload) => {
      received.push(payload.query);
      if (payload.query !== 'slow launch') return undefined;
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });
    dispatchQuickQueryEvent({ query: 'slow launch', submittedAt: 1 }, firstClaim);
    dispatchQuickQueryEvent({ query: 'waits its turn', submittedAt: 2 }, secondClaim);

    await waitFor(() => expect(received).toEqual(['slow launch']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondClaim).not.toHaveBeenCalled();

    finishFirst?.();
    await waitFor(() => expect(received).toEqual(['slow launch', 'waits its turn']));
    expect(secondClaim).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('leaves a queued submit unclaimed when its consumer goes away mid-launch', async () => {
    let finishFirst: (() => void) | null = null;
    const firstClaim = vi.fn(() => Promise.resolve(true));
    const secondClaim = vi.fn(() => Promise.resolve(true));
    const early: string[] = [];
    const unsubscribeEarly = subscribeQuickQuery((payload) => {
      early.push(payload.query);
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });
    dispatchQuickQueryEvent({ query: 'in flight', submittedAt: 1 }, firstClaim);
    dispatchQuickQueryEvent({ query: 'queued behind', submittedAt: 2 }, secondClaim);
    await waitFor(() => expect(early).toEqual(['in flight']));

    unsubscribeEarly();
    finishFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondClaim).not.toHaveBeenCalled();

    const late: string[] = [];
    const unsubscribeLate = subscribeQuickQuery((payload) => {
      late.push(payload.query);
    });
    await waitFor(() => expect(late).toEqual(['queued behind']));
    expect(secondClaim).toHaveBeenCalledTimes(1);
    unsubscribeLate();
  });

  it('keeps a submit that was claimed just as its consumer went away', async () => {
    let grant: ((claimed: boolean) => void) | null = null;
    const claim = () =>
      new Promise<boolean>((resolve) => {
        grant = resolve;
      });

    const early: string[] = [];
    const unsubscribeEarly = subscribeQuickQuery((payload) => early.push(payload.query));
    dispatchQuickQueryEvent({ query: 'claimed in flight', submittedAt: 1 }, claim);
    await Promise.resolve();
    unsubscribeEarly();
    grant?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(early).toEqual([]);

    const late: string[] = [];
    const unsubscribeLate = subscribeQuickQuery((payload) => late.push(payload.query));
    expect(late).toEqual(['claimed in flight']);
    unsubscribeLate();
  });
});
