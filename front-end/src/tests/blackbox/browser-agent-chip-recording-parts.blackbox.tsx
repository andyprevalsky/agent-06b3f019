/**
 * Blackbox tests for multi-part BrowserAgentChip recordings. An approval or
 * auth-assistance pause ends the browser activity and saves its recording; the
 * resumed activity saves another for the same task. The chip must play every
 * part, ordered and placed by each part's own start (prod agent 8b4d4592: a
 * 60-step task whose chip played only the last ~3 links).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Message } from '@/lib/api';

vi.mock('@/lib/api/messages', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/messages')>()),
  getAttachmentUrl: vi.fn(async () => 'https://signed.example/recording'),
}));

import { getAttachmentUrl } from '@/lib/api/messages';
import { buildRecordingSegments } from '@/features/terminal-component-group/components/browser-agent-chip/recordingSegments';
import {
  anchorMsg,
  CALL,
  chipElement,
  KERNEL_VIEW_URL,
  openRecordingTab,
  recordingMsgWithId,
  renderChip,
  TASK,
} from './browser-agent-chip.fixtures';

function htmlPointer(id: string) {
  return { id, storage_path: `user/${id}.html`, mime_type: 'text/html' };
}

function step(id: string, timestamp: string, title: string): Message {
  return {
    message_id: id,
    timestamp,
    role: 'TOOL',
    text: '',
    metadata: {
      task_id: TASK,
      toolName: 'spawn_browser_agent',
      action_type: 'click',
      toolStatus: 'FINISHED',
      title,
    },
  };
}

/** Blob URLs named after the signed URL they were downloaded from. */
function stubDownloads() {
  vi.mocked(getAttachmentUrl).mockReset();
  vi.mocked(getAttachmentUrl).mockImplementation(
    async (_agent, fileId) => `https://signed.example/${fileId}`,
  );
  let lastFetched = '';
  const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    lastFetched = String(input).split('/').pop() ?? '';
    return {
      ok: true,
      text: async () => '<!doctype html>',
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response;
  });
  const createSpy = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation(() => `blob:${lastFetched}`);
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return {
    fetchSpy,
    revokeSpy,
    restore() {
      fetchSpy.mockRestore();
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    },
  };
}

function controlVideo(video: HTMLVideoElement, duration: number) {
  let currentTime = 0;
  Object.defineProperty(video, 'duration', { configurable: true, value: duration });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });
  video.play = vi.fn(async () => {}) as unknown as typeof video.play;
  return () => currentTime;
}

const playingSrc = () => screen.getByTitle('Browser recording').getAttribute('src');

describe('BrowserAgentChip multi-part recording', () => {
  it('plays every recording of a task split by an auth-assistance pause, earliest first', async () => {
    // Captured from prod agent 8b4d4592: one 60-step browser task paused for the
    // user's login. The pre-pause activity saved part 1 (steps 1-50) and the
    // resumed activity saved part 2 (steps 51-60), each on different browser
    // sessions. Playing only the newest part showed ~3 links of a 60-step run.
    const part1 = {
      id: 'fp-part-1',
      storage_path: 'user/part-1_browser-recording.html',
      mime_type: 'text/html',
    };
    const part2 = {
      id: 'fp-part-2',
      storage_path: 'user/part-2_browser-recording.html',
      mime_type: 'text/html',
    };
    const createObjSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:part-1')
      .mockReturnValueOnce('blob:part-2');
    const revokeObjSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '<!doctype html><title>Browser recording</title>',
    } as unknown as Response);
    vi.mocked(getAttachmentUrl).mockClear();

    const messages = [
      anchorMsg,
      recordingMsgWithId('rec-start-1', '2026-10-08T18:20:28.637Z', {
        toolStatus: 'IN_PROGRESS',
        browser_url: 'https://prod-iad-hypeman-3.kernel.sh:8443/browser/live/8ncskyVhBqSj',
        recording_path: '/tmp/rose-browser-agent-recordings/agent/task/index.html',
      }),
      recordingMsgWithId('rec-saved-1', '2026-10-08T18:32:07.386Z', {
        browser_url: 'https://connect.steel.dev/v1/sessions/f26ee1ab/player?interactive=false',
        recording_file_pointer: part1,
      }),
      {
        message_id: 'auth-assistance',
        timestamp: '2026-10-09T20:34:10.619Z',
        role: 'TOOL',
        text: '',
        metadata: {
          task_id: TASK,
          toolCallId: CALL,
          toolName: 'spawn_browser_agent',
          action_type: 'auth_assistance',
          toolStatus: 'FINISHED',
          title: 'User Assistance Received',
        },
      } as Message,
      recordingMsgWithId('rec-start-2', '2026-10-09T20:34:30.641Z', {
        toolStatus: 'IN_PROGRESS',
        browser_url: 'https://connect.steel.dev/v1/sessions/201b22cb/player?interactive=false',
        recording_path: '/tmp/rose-browser-agent-recordings/agent/task/index.html',
      }),
      recordingMsgWithId('rec-saved-2', '2026-10-09T20:40:55.042Z', {
        browser_url: 'https://prod-iad-hypeman-28.kernel.sh:8443/browser/live/pmHw1BNYtFaS',
        recording_file_pointer: part2,
      }),
    ];
    const { unmount } = renderChip(messages, anchorMsg);

    await openRecordingTab();

    // The earliest part plays first, so the run is watched from its beginning.
    await waitFor(() =>
      expect(screen.getByTitle('Browser recording').getAttribute('src')).toBe('blob:part-1'),
    );
    expect(getAttachmentUrl).toHaveBeenLastCalledWith('agent-1', part1.id, part1.storage_path, {
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByTestId('recording-segments')).toBeInTheDocument();

    // Every later part stays reachable from the same player.
    fireEvent.click(screen.getByRole('button', { name: 'Play recording part 2 of 2' }));
    await waitFor(() =>
      expect(screen.getByTitle('Browser recording').getAttribute('src')).toBe('blob:part-2'),
    );
    expect(getAttachmentUrl).toHaveBeenLastCalledWith('agent-1', part2.id, part2.storage_path, {
      signal: expect.any(AbortSignal),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Play recording part 1 of 2' }));
    await waitFor(() =>
      expect(screen.getByTitle('Browser recording').getAttribute('src')).toBe('blob:part-1'),
    );
    // Returning to a loaded part reuses its Blob instead of downloading it again.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    unmount();
    expect(revokeObjSpy).toHaveBeenCalledWith('blob:part-1');
    expect(revokeObjSpy).toHaveBeenCalledWith('blob:part-2');

    createObjSpy.mockRestore();
    revokeObjSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('advances from a pre-pause Kernel replay into the resumed screenshot part', async () => {
    // A Kernel session records natively before the pause; the resumed activity
    // lands on a Steel session and saves an HTML screenshot player instead.
    const createObjSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:resumed-part');
    const revokeObjSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '<!doctype html>',
    } as unknown as Response);
    const messages = [
      anchorMsg,
      recordingMsgWithId('rec-kernel', '2026-07-16T00:00:00Z', {
        recording_view_url: KERNEL_VIEW_URL,
        browser_url: 'https://proxy.example.onkernel.com:8443/browser/live/session-1',
      }),
      recordingMsgWithId('rec-html', '2026-07-16T00:05:00Z', {
        browser_url: 'https://connect.steel.dev/v1/sessions/session-2/player',
        recording_file_pointer: {
          id: 'fp-resumed',
          storage_path: 'user/resumed-part.html',
          mime_type: 'text/html',
        },
      }),
    ];
    const { unmount } = renderChip(messages, anchorMsg);

    await openRecordingTab();

    const video = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    expect(video.src).toBe(KERNEL_VIEW_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText('part 1')).toBeInTheDocument();

    fireEvent.ended(video);
    await waitFor(() =>
      expect(screen.getByTitle('Browser recording').getAttribute('src')).toBe('blob:resumed-part'),
    );
    expect(screen.getByTitle('Browser recording').tagName).toBe('IFRAME');
    expect(screen.getByText('part 2')).toBeInTheDocument();

    unmount();
    expect(revokeObjSpy).toHaveBeenCalledWith('blob:resumed-part');
    createObjSpy.mockRestore();
    revokeObjSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('orders parts by when they started, not when they were saved', async () => {
    // A background finalizer can save the pre-pause part after a short resumed
    // part has already saved its own.
    const downloads = stubDownloads();
    const messages = [
      anchorMsg,
      recordingMsgWithId('rec-resumed', '2026-10-08T18:35:00Z', {
        recording_started_at: '2026-10-08T18:30:00Z',
        recording_file_pointer: htmlPointer('resumed'),
      }),
      recordingMsgWithId('rec-first', '2026-10-08T18:40:00Z', {
        recording_started_at: '2026-10-08T18:20:00Z',
        recording_file_pointer: htmlPointer('first'),
      }),
    ];
    renderChip(messages, anchorMsg);
    await openRecordingTab();

    await waitFor(() => expect(playingSrc()).toBe('blob:first'));
    fireEvent.click(screen.getByRole('button', { name: 'Next part ›' }));
    await waitFor(() => expect(playingSrc()).toBe('blob:resumed'));
    expect(screen.queryByRole('button', { name: 'Next part ›' })).not.toBeInTheDocument();
    downloads.restore();
  });

  it('pairs older rows without a stamped start with their own activity start', () => {
    // Rows saved before recording_started_at existed: the pre-pause part is
    // saved after the resumed part started and saved.
    const started = (id: string, timestamp: string) =>
      recordingMsgWithId(id, timestamp, { toolStatus: 'IN_PROGRESS' });
    const saved = (id: string, timestamp: string) =>
      recordingMsgWithId(id, timestamp, { recording_file_pointer: htmlPointer(id) });
    const segments = buildRecordingSegments([
      started('start-1', '2026-10-08T18:20:00Z'),
      started('start-2', '2026-10-09T20:34:00Z'),
      saved('saved-2', '2026-10-09T20:40:00Z'),
      saved('saved-1', '2026-10-09T20:41:00Z'),
    ]);
    expect(segments.map((segment) => segment.key)).toEqual([
      'user/saved-1.html',
      'user/saved-2.html',
    ]);
    expect(segments.map((segment) => segment.partStartMs)).toEqual([
      Date.parse('2026-10-08T18:20:00Z'),
      Date.parse('2026-10-09T20:34:00Z'),
    ]);
  });

  it('keeps the step list aligned across a pause between parts', async () => {
    const t0 = '2026-10-08T18:00:00.000Z';
    const resumed = '2026-10-08T20:00:00.000Z';
    const partOne = `${KERNEL_VIEW_URL}&part=1`;
    const partTwo = `${KERNEL_VIEW_URL}&part=2`;
    const messages: Message[] = [
      { ...recordingMsgWithId('start-1', t0, { toolStatus: 'IN_PROGRESS' }) },
      step('before-pause', '2026-10-08T18:00:05.000Z', 'Open sign-in'),
      recordingMsgWithId('rec-1', '2026-10-08T18:00:40.000Z', {
        recording_started_at: t0,
        recording_view_url: partOne,
      }),
      step('after-pause', '2026-10-08T20:00:10.000Z', 'Open orders'),
      recordingMsgWithId('rec-2', '2026-10-08T20:01:00.000Z', {
        recording_started_at: resumed,
        recording_view_url: partTwo,
      }),
      anchorMsg,
    ];
    renderChip(messages, anchorMsg);
    await openRecordingTab();

    const first = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    expect(first.src).toBe(partOne);
    controlVideo(first, 40);
    fireEvent.ended(first);
    const second = await waitFor(() => {
      const video = screen.getByTitle('Browser recording') as HTMLVideoElement;
      expect(video.src).toBe(partTwo);
      return video;
    });
    controlVideo(second, 60);
    second.currentTime = 15;
    fireEvent.timeUpdate(second);
    // Part 2 starts at its own wall-clock start (two hours later), not at the
    // end of part 1's 40 s of video.
    await waitFor(() => {
      const active = screen.getByTestId('recording-active-step');
      expect(active).toHaveTextContent('Open orders');
    });
    expect(screen.getByTestId('recording-playhead')).toHaveTextContent('t=7215.0s');
  });

  it('seeks into a part that has to download first', async () => {
    const downloads = stubDownloads();
    const t0 = '2026-10-08T18:00:00.000Z';
    const messages: Message[] = [
      { ...recordingMsgWithId('start-1', t0, { toolStatus: 'IN_PROGRESS' }) },
      recordingMsgWithId('rec-1', '2026-10-08T18:00:40.000Z', {
        recording_started_at: t0,
        recording_view_url: KERNEL_VIEW_URL,
      }),
      step('after-pause', '2026-10-08T19:00:20.000Z', 'Open orders'),
      recordingMsgWithId('rec-2', '2026-10-08T19:01:00.000Z', {
        recording_started_at: '2026-10-08T19:00:00.000Z',
        recording_file_pointer: {
          id: 'stitched',
          storage_path: 'user/stitched.mp4',
          mime_type: 'video/mp4',
        },
      }),
      anchorMsg,
    ];
    renderChip(messages, anchorMsg);
    await openRecordingTab();
    const first = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    controlVideo(first, 40);

    fireEvent.click(screen.getByText('Open orders'));
    const second = await waitFor(() => {
      const video = screen.getByTitle('Browser recording') as HTMLVideoElement;
      expect(video.getAttribute('src')).toBe('blob:stitched');
      return video;
    });
    const currentTime = controlVideo(second, 90);
    fireEvent.loadedMetadata(second);
    expect(currentTime()).toBe(20);
    downloads.restore();
  });

  it('keeps playing the opened part when an earlier-starting part arrives late', async () => {
    // A background finalizer can save the pre-pause part after the resumed part:
    // the viewer is already watching the resumed part when it appears.
    const downloads = stubDownloads();
    const resumedPart = [
      anchorMsg,
      recordingMsgWithId('rec-resumed', '2026-10-09T20:40:00Z', {
        recording_started_at: '2026-10-09T20:34:00Z',
        recording_file_pointer: htmlPointer('resumed'),
      }),
    ];
    const { rerender } = renderChip(resumedPart, anchorMsg);
    await openRecordingTab();
    await waitFor(() => expect(playingSrc()).toBe('blob:resumed'));

    rerender(
      chipElement(
        [
          ...resumedPart,
          recordingMsgWithId('rec-first', '2026-10-09T20:41:00Z', {
            recording_started_at: '2026-10-08T18:20:00Z',
            recording_file_pointer: htmlPointer('first'),
          }),
        ],
        anchorMsg,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('recording-segments')).toBeInTheDocument());
    // The new part sorts first, but playback stays on the part being watched.
    expect(screen.getByText('part 2')).toBeInTheDocument();
    expect(playingSrc()).toBe('blob:resumed');
    expect(downloads.fetchSpy).toHaveBeenCalledTimes(1);
    downloads.restore();
  });

  it('keeps the playing part and its download when a later part arrives', async () => {
    const downloads = stubDownloads();
    const firstPart = [
      anchorMsg,
      recordingMsgWithId('rec-1', '2026-10-08T18:32:00Z', {
        recording_started_at: '2026-10-08T18:20:00Z',
        recording_file_pointer: htmlPointer('first'),
      }),
    ];
    const { rerender } = renderChip(firstPart, anchorMsg);
    await openRecordingTab();
    await waitFor(() => expect(playingSrc()).toBe('blob:first'));

    rerender(
      chipElement(
        [
          ...firstPart,
          recordingMsgWithId('rec-2', '2026-10-09T20:40:00Z', {
            recording_started_at: '2026-10-09T20:34:00Z',
            recording_file_pointer: htmlPointer('resumed'),
          }),
        ],
        anchorMsg,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('recording-segments')).toBeInTheDocument());
    expect(playingSrc()).toBe('blob:first');
    expect(downloads.fetchSpy).toHaveBeenCalledTimes(1);
    expect(downloads.revokeSpy).not.toHaveBeenCalled();
    downloads.restore();
  });

  it('never starts a recording download when signing lands after the chip closes', async () => {
    const downloads = stubDownloads();
    let sign: (url: string) => void = () => {};
    vi.mocked(getAttachmentUrl).mockImplementationOnce(
      () => new Promise<string>((resolve) => (sign = resolve)),
    );
    const messages = [
      anchorMsg,
      recordingMsgWithId('rec-1', '2026-10-08T18:32:00Z', {
        recording_file_pointer: htmlPointer('late'),
      }),
    ];
    const { unmount } = renderChip(messages, anchorMsg);
    await openRecordingTab();
    await waitFor(() => expect(getAttachmentUrl).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => sign('https://signed.example/late'));
    expect(downloads.fetchSpy).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(downloads.revokeSpy).not.toHaveBeenCalled();
    downloads.restore();
  });
});
