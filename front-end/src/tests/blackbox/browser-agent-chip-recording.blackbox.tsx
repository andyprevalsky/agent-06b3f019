/**
 * Blackbox tests for BrowserAgentChip recording playback — the FE contract that
 * must survive the swap from our screenshot+Supabase player to Kernel-native
 * replay. Both recording sources land on the SAME Recording tab / iframe:
 *  - recording_view_url (Kernel replay): iframed directly, no fetch.
 *  - recording_file_pointer (Supabase):  fetched -> text/html Blob -> iframed.
 * A recording_view_url, when present, is preferred over the FilePointer.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Message } from '@/lib/api';

// The stitched-MP4 path resolves a Supabase attachment URL, so stub the resolver.
vi.mock('@/lib/api/messages', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/messages')>()),
  getAttachmentUrl: vi.fn(async () => 'https://signed.example/stitched.mp4'),
}));

import { getAttachmentUrl } from '@/lib/api/messages';
import {
  anchorMsg,
  KERNEL_VIEW_URL,
  openRecordingTab,
  recordingMsg,
  recordingMsgWithId,
  renderChip,
  TASK,
} from './browser-agent-chip.fixtures';

describe('BrowserAgentChip recording', () => {
  it('streams the Kernel recording_view_url in a <video> directly (no fetch)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const messages = [anchorMsg, recordingMsg({ recording_view_url: KERNEL_VIEW_URL })];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    const video = await screen.findByTitle('Browser recording');
    expect(video.tagName).toBe('VIDEO');
    expect((video as HTMLVideoElement).src).toBe(KERNEL_VIEW_URL);
    // Kernel replay streams the MP4 directly — we must NOT hit the Supabase fetch path.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('prefers recording_view_url over a legacy recording_file_pointer', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const messages = [
      anchorMsg,
      recordingMsg({
        recording_view_url: KERNEL_VIEW_URL,
        recording_file_pointer: { id: 'fp-1', storage_path: 'user/abc.html' },
      }),
    ];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    const video = await screen.findByTitle('Browser recording');
    expect((video as HTMLVideoElement).src).toBe(KERNEL_VIEW_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('plays the server-stitched MP4 as ONE <video> (video/mp4 pointer)', async () => {
    // The preferred path: rotate_ip's per-session segments are concatenated
    // server-side into one continuous MP4 and uploaded. The chip fetches it as a
    // video blob and plays a SINGLE player — no segment strip, no playlist.
    const createObjSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:stitched-recording');
    const revokeObjSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(64),
    } as unknown as Response);

    const messages = [
      anchorMsg,
      recordingMsg({
        recording_file_pointer: {
          id: 'fp-mp4',
          storage_path: 'user/browser-recording-task.mp4',
          mime_type: 'video/mp4',
        },
        // A stitched pointer must win even if segment URLs are also present.
        recording_view_urls: [`${KERNEL_VIEW_URL}&seg=0`, `${KERNEL_VIEW_URL}&seg=1`],
      }),
    ];
    const { unmount } = renderChip(messages, anchorMsg);

    await openRecordingTab();

    const video = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.src).toBe('blob:stitched-recording');
    // Blobbed from a video/mp4 payload, and no per-segment playlist strip.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('recording-segments')).not.toBeInTheDocument();

    unmount();
    expect(revokeObjSpy).toHaveBeenCalledWith('blob:stitched-recording');

    createObjSpy.mockRestore();
    revokeObjSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('auto-advances through per-rotation segments as one continuous video', async () => {
    // rotate_ip produces one replay segment per session (baseline + one per
    // rotation), each on a different exit IP. The chip stitches them into ONE
    // continuous player: each segment auto-advances to the next when it ends, so
    // the recording plays the IP changing without any manual tab switching.
    const seg0 = `${KERNEL_VIEW_URL}&seg=0`;
    const seg1 = `${KERNEL_VIEW_URL}&seg=1`;
    const seg2 = `${KERNEL_VIEW_URL}&seg=2`;
    const messages = [
      anchorMsg,
      recordingMsg({
        recording_view_url: seg0,
        recording_view_urls: [seg0, seg1, seg2],
      }),
    ];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    // Plays the baseline segment first.
    const video = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.src).toBe(seg0);

    // The segment strip shows the playhead (baseline first).
    expect(screen.getByTestId('recording-segments')).toBeInTheDocument();
    expect(screen.getByText('baseline IP')).toBeInTheDocument();

    // When a segment ends, the player auto-advances to the next session's clip
    // and the status strip follows the playhead.
    fireEvent.ended(video);
    await waitFor(() =>
      expect((screen.getByTitle('Browser recording') as HTMLVideoElement).src).toBe(seg1),
    );
    expect(screen.getByText('rotation 1')).toBeInTheDocument();
    fireEvent.ended(screen.getByTitle('Browser recording'));
    await waitFor(() =>
      expect((screen.getByTitle('Browser recording') as HTMLVideoElement).src).toBe(seg2),
    );
    expect(screen.getByText('rotation 2')).toBeInTheDocument();

    // The final segment does not advance past the end.
    fireEvent.ended(screen.getByTitle('Browser recording'));
    await waitFor(() =>
      expect((screen.getByTitle('Browser recording') as HTMLVideoElement).src).toBe(seg2),
    );
  });

  it('plays approval-split replays from the same browser session in chronological order', async () => {
    const browserUrl = 'https://proxy.example.onkernel.com:8443/browser/live/session-1';
    const beforeApproval = `${KERNEL_VIEW_URL}&replay_id=before-approval`;
    const afterApproval = `${KERNEL_VIEW_URL}&replay_id=after-approval`;
    const messages = [
      anchorMsg,
      recordingMsgWithId('rec-before', '2026-07-16T00:00:00Z', {
        recording_view_url: beforeApproval,
        browser_url: browserUrl,
      }),
      recordingMsgWithId('rec-after', '2026-07-16T00:00:01Z', {
        recording_view_url: afterApproval,
        browser_url: browserUrl,
      }),
    ];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    const video = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    expect(video.src).toBe(beforeApproval);
    expect(screen.getByTestId('recording-segments')).toBeInTheDocument();

    fireEvent.ended(video);
    await waitFor(() =>
      expect((screen.getByTitle('Browser recording') as HTMLVideoElement).src).toBe(afterApproval),
    );
  });

  it('shows no segment strip for a single-segment (unrotated) recording', async () => {
    const messages = [
      anchorMsg,
      recordingMsg({
        recording_view_url: KERNEL_VIEW_URL,
        recording_view_urls: [KERNEL_VIEW_URL],
      }),
    ];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    const video = await screen.findByTitle('Browser recording');
    expect((video as HTMLVideoElement).src).toBe(KERNEL_VIEW_URL);
    expect(screen.queryByTestId('recording-segments')).not.toBeInTheDocument();
  });

  it('tells the viewer to sign in as the owner when attachment signing is denied', async () => {
    vi.mocked(getAttachmentUrl).mockRejectedValueOnce(
      new Error('Failed to get attachment URL (403)'),
    );
    const messages = [
      anchorMsg,
      recordingMsg({
        recording_file_pointer: {
          id: 'fp-1',
          storage_path: 'owner/browser-recording.html',
          mime_type: 'text/html',
        },
      }),
    ];
    renderChip(messages, anchorMsg);
    await openRecordingTab();
    expect(
      await screen.findByText('Sign in as the agent owner to load this recording.'),
    ).toBeInTheDocument();
  });

  it('shows "unavailable" when neither a view URL nor a file pointer is present', async () => {
    const messages = [anchorMsg, recordingMsg({})];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    expect(await screen.findByText('Recording unavailable for this run.')).toBeInTheDocument();
    expect(screen.queryByTitle('Browser recording')).not.toBeInTheDocument();
  });

  it('shows a live trajectory side panel beside the recording', async () => {
    const t0 = '2026-07-16T00:00:00.000Z';
    const messages: Message[] = [
      {
        ...anchorMsg,
        message_id: 'complete-live',
        timestamp: '2026-07-16T00:02:00.000Z',
      },
      recordingMsg({
        recording_view_url: KERNEL_VIEW_URL,
        // recording row timestamp is the scrub origin
      }),
      {
        message_id: 'step-goto',
        timestamp: '2026-07-16T00:00:05.000Z',
        role: 'TOOL' as const,
        text: '',
        metadata: {
          task_id: TASK,
          toolName: 'spawn_browser_agent',
          action_type: 'goto',
          toolStatus: 'FINISHED',
          title: 'Open menu',
        },
      },
      {
        message_id: 'step-click',
        timestamp: '2026-07-16T00:00:40.000Z',
        role: 'TOOL' as const,
        text: '',
        metadata: {
          task_id: TASK,
          toolName: 'spawn_browser_agent',
          action_type: 'click',
          toolStatus: 'FINISHED',
          title: 'Pick Almond Oat Latte',
        },
      },
    ];
    // Force the recording message timestamp to t0 so offsets are deterministic.
    messages[1] = { ...messages[1], timestamp: t0 };
    renderChip(messages, messages[0]);

    await openRecordingTab();

    expect(await screen.findByTestId('recording-with-live-trajectory')).toBeInTheDocument();
    expect(screen.getByTestId('recording-live-trajectory')).toBeInTheDocument();
    expect(screen.getByText('Open menu')).toBeInTheDocument();
    expect(screen.getByText('Pick Almond Oat Latte')).toBeInTheDocument();
  });

  it('updates the live trajectory highlight when the recording is scrubbed', async () => {
    const t0 = '2026-07-16T00:00:00.000Z';
    const anchor = {
      ...anchorMsg,
      message_id: 'complete-scrub',
      timestamp: '2026-07-16T00:02:00.000Z',
    };
    const messages: Message[] = [
      anchor,
      { ...recordingMsg({ recording_view_url: KERNEL_VIEW_URL }), timestamp: t0 },
      {
        message_id: 'step-goto',
        timestamp: '2026-07-16T00:00:05.000Z',
        role: 'TOOL' as const,
        text: '',
        metadata: {
          task_id: TASK,
          toolName: 'spawn_browser_agent',
          action_type: 'goto',
          toolStatus: 'FINISHED',
          title: 'Open menu',
        },
      },
      {
        message_id: 'step-click',
        timestamp: '2026-07-16T00:00:40.000Z',
        role: 'TOOL' as const,
        text: '',
        metadata: {
          task_id: TASK,
          toolName: 'spawn_browser_agent',
          action_type: 'click',
          toolStatus: 'FINISHED',
          title: 'Pick Almond Oat Latte',
        },
      },
    ];
    renderChip(messages, anchor);

    await openRecordingTab();

    const video = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    // Before the first step: no active highlight.
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 1 });
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    fireEvent.timeUpdate(video);
    expect(screen.queryByTestId('recording-active-step')).not.toBeInTheDocument();

    // Scrub into the goto step window.
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 10 });
    fireEvent.seeked(video);
    await waitFor(() => {
      const active = screen.getByTestId('recording-active-step');
      expect(active).toHaveAttribute('data-step-index', '0');
      expect(active).toHaveTextContent('Open menu');
    });

    // Scrub further to the click step.
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 45 });
    fireEvent.timeUpdate(video);
    await waitFor(() => {
      const active = screen.getByTestId('recording-active-step');
      expect(active).toHaveAttribute('data-step-index', '1');
      expect(active).toHaveTextContent('Pick Almond Oat Latte');
    });
    expect(screen.getByTestId('recording-playhead')).toHaveTextContent('t=45.0s');
  });

  it('clicking a trajectory step seeks the video to that step offset and shows the full title', async () => {
    const longTitle =
      'Browser challenge recovery failed: No stable browser configuration cleared the challenge (Steel fixed-IP proxies unavailable)';
    const t0 = '2026-07-16T00:00:00.000Z';
    const messages: Message[] = [
      { ...recordingMsg({ recording_view_url: KERNEL_VIEW_URL }), timestamp: t0 },
      {
        message_id: 'step-wait',
        timestamp: '2026-07-16T00:00:10.000Z',
        role: 'TOOL' as const,
        text: '',
        metadata: {
          task_id: TASK,
          toolName: 'spawn_browser_agent',
          action_type: 'browser_challenge_recovery',
          toolStatus: 'IN_PROGRESS',
          title: 'Waiting for the browser provider automatic CAPTCHA solver',
        },
      },
      {
        message_id: 'step-fail',
        timestamp: '2026-07-16T00:00:40.000Z',
        role: 'TOOL' as const,
        text: '',
        metadata: {
          task_id: TASK,
          toolName: 'spawn_browser_agent',
          action_type: 'browser_challenge_recovery',
          toolStatus: 'ERROR',
          title: longTitle,
        },
      },
      anchorMsg,
    ];
    renderChip(messages, anchorMsg);
    await openRecordingTab();

    const video = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    let currentTime = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: (v: number) => {
        currentTime = v;
      },
    });
    video.play = vi.fn(async () => {}) as unknown as typeof video.play;

    // Full title is visible (not Cap…/Bro… truncated).
    expect(screen.getByText(longTitle)).toBeInTheDocument();

    // Click the failed recovery step → seek to its offset (40s).
    fireEvent.click(screen.getByText(longTitle));
    await waitFor(() => {
      expect(currentTime).toBe(40);
    });
    fireEvent.seeked(video);
    await waitFor(() => {
      const active = screen.getByTestId('recording-active-step');
      expect(active).toHaveAttribute('data-step-offset', '40');
      expect(active).toHaveTextContent(longTitle);
    });
    expect(screen.getByTestId('recording-playhead')).toHaveTextContent('t=40.0s');
  });

  it('leads the result with the goal and judges status from the Status line', () => {
    const goalFirst = (status: string) =>
      `**Goal**: Find the error banner and report what failed\n\n**Status**: ${status}\n\n**Outcome**: Banner says the upload failed`;
    const success = { ...anchorMsg, text: goalFirst('✅ SUCCESS') };
    const { unmount } = renderChip([success], success);
    const header = screen.getByTestId('browser-agent-chip-header');
    expect(header).toHaveTextContent('Done');
    expect(header).not.toHaveTextContent('Failed');
    // Andy 2026-10-28: the collapsed preview leads with the goal, without raw markdown.
    const collapsed = screen.getByText(/^Goal: Find the error banner/);
    expect(collapsed.textContent).not.toContain('**');
    unmount();

    const failure = { ...anchorMsg, text: goalFirst('❌ FAILED') };
    renderChip([failure], failure);
    expect(screen.getByTestId('browser-agent-chip-header')).toHaveTextContent('Failed');
  });

  it('exposes only Result and Recording tabs (trajectory lives inside Recording)', async () => {
    const messages = [anchorMsg, recordingMsg({ recording_view_url: KERNEL_VIEW_URL })];
    renderChip(messages, anchorMsg);

    fireEvent.click(screen.getByTestId('browser-agent-chip-header'));
    await waitFor(() => expect(screen.getByText(/^Recording/)).toBeInTheDocument());
    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.queryByText(/^Trajectory/)).not.toBeInTheDocument();
  });
});
