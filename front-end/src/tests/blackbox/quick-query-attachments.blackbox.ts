/**
 * Blackbox: quick-launcher payloads with file attachments.
 *
 * The launcher window holds local File bytes and forwards them over IPC.
 * useQuickQuery (main window) must upload those bytes, then createAgent with
 * the resulting file pointers.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useQuickQuery, type QuickQueryDeps } from '@/features/terminal/hooks/useQuickQuery';
import {
  dispatchQuickQueryEvent,
  goalFromQuickLauncherPayload,
  type QuickLauncherPayload,
} from '@/lib/quickQuery';

const createAgent = vi.fn(async () => ({ agent_id: 'agent-qq-1' }));
const uploadAttachment = vi.fn(async (file: File) => ({
  id: `fp-${file.name}`,
  storage_path: `attachments/u/${file.name}`,
  original_filename: file.name,
  mime_type: file.type || 'application/octet-stream',
  size_bytes: file.size,
  created_at: new Date().toISOString(),
}));

vi.mock('@/features/terminal/api', () => ({
  createAgent: (...args: unknown[]) => createAgent(...args),
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...(args as [File])),
}));

function makeDeps(overrides: Partial<QuickQueryDeps> = {}): QuickQueryDeps {
  return {
    selectedModel: 'rose-1-lite',
    canSubmitGoals: true,
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
