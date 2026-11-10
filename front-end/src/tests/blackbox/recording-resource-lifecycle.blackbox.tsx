/** Recording requests belong to a mounted viewer and its current segment set. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRecordingSegmentLoads } from '@/features/terminal-component-group/components/browser-agent-chip/useRecordingSegmentLoads';
import type { RecordingSegment } from '@/features/terminal-component-group/components/browser-agent-chip/recordingSegments';
import { getAttachmentUrl } from '@/lib/api/messages';

vi.mock('@/lib/api/messages', () => ({ getAttachmentUrl: vi.fn() }));

const segment: RecordingSegment = {
  kind: 'video',
  key: 'stored-recording',
  partIndex: 0,
  label: 'Part 1',
  partStartMs: null,
  pointer: {
    id: 'recording',
    storage_path: 'user/recording.mp4',
    mime_type: 'video/mp4',
    original_filename: 'recording.mp4',
    size_bytes: 8,
    created_at: '2026-11-02T00:00:00Z',
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setupDownload() {
  vi.mocked(getAttachmentUrl).mockResolvedValue('https://signed.example/recording');
  const pending = deferred<Response>();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { pending, fetchSpy, create, revoke };
}

const response = () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as Response;
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getAttachmentUrl).mockReset();
});

describe('recording resource lifecycle', () => {
  it('aborts hidden-view downloads and resumes loading when reopened', async () => {
    const { fetchSpy, pending } = setupDownload();
    const { result, rerender } = renderHook(
      ({ opened }) => useRecordingSegmentLoads([segment], opened, 'agent-1'),
      { initialProps: { opened: true } },
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const signal = fetchSpy.mock.calls[0][1]?.signal;
    rerender({ opened: false });
    expect(signal?.aborted).toBe(true);
    expect(result.current.recordingState).toBe('idle');
    fetchSpy.mockImplementation(async () => response());
    rerender({ opened: true });
    await waitFor(() => expect(result.current.recordingState).toBe('ready'));
    await act(async () => {
      pending.resolve(response());
    });
    expect(result.current.recordingUrl).toBe('blob:recording');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('aborts an outstanding byte download when its viewer unmounts', async () => {
    const { fetchSpy } = setupDownload();
    const { unmount } = renderHook(() => useRecordingSegmentLoads([segment], true, 'agent-1'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const signal = fetchSpy.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('does not start the byte download when URL signing finishes after unmount', async () => {
    const { fetchSpy, create } = setupDownload();
    const signed = deferred<string>();
    vi.mocked(getAttachmentUrl).mockReturnValue(signed.promise);
    const { unmount } = renderHook(() => useRecordingSegmentLoads([segment], true, 'agent-1'));
    unmount();
    await act(async () => {
      signed.resolve('https://signed.example/late');
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('cancels removed segments and starts a fresh request if the same segment returns', async () => {
    const { fetchSpy, pending, create } = setupDownload();
    const { result, rerender } = renderHook(
      ({ segments }) => useRecordingSegmentLoads(segments, true, 'agent-1'),
      { initialProps: { segments: [segment] } },
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const signal = fetchSpy.mock.calls[0][1]?.signal;
    rerender({ segments: [] });
    expect(signal?.aborted).toBe(true);
    const next = deferred<Response>();
    fetchSpy.mockReturnValue(next.promise);
    rerender({ segments: [segment] });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending.resolve(response());
    });
    expect(create).not.toHaveBeenCalled();
    expect(result.current.recordingState).toBe('loading');
    await act(async () => {
      next.resolve(response());
    });
    expect(result.current.recordingUrl).toBe('blob:recording');
  });

  it('releases each completed blob on agent switches and reloads for the new owner', async () => {
    const { fetchSpy, pending, revoke } = setupDownload();
    const { result, rerender, unmount } = renderHook(
      ({ agentId }) => useRecordingSegmentLoads([segment], true, agentId),
      { initialProps: { agentId: 'agent-0' } },
    );
    await act(async () => {
      pending.resolve(response());
    });
    await waitFor(() => expect(result.current.recordingState).toBe('ready'));
    fetchSpy.mockImplementation(async () => response());
    for (let index = 1; index <= 20; index += 1) {
      rerender({ agentId: `agent-${index}` });
      await waitFor(() =>
        expect(getAttachmentUrl).toHaveBeenLastCalledWith(
          `agent-${index}`,
          'recording',
          'user/recording.mp4',
          { signal: expect.any(AbortSignal) },
        ),
      );
      await waitFor(() => expect(result.current.recordingState).toBe('ready'));
      expect(revoke).toHaveBeenCalledTimes(index);
    }
    unmount();
    expect(revoke).toHaveBeenCalledTimes(21);
  });
});
