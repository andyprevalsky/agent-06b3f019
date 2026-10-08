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
  dispatchQuickQueryEvent,
  goalFromQuickLauncherPayload,
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
