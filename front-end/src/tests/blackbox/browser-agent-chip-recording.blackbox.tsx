/**
 * Blackbox tests for BrowserAgentChip recording playback — the FE contract that
 * must survive the swap from our screenshot+Supabase player to Kernel-native
 * replay. Both recording sources land on the SAME Recording tab / iframe:
 *  - recording_view_url (Kernel replay): iframed directly, no fetch.
 *  - recording_file_pointer (Supabase):  fetched -> text/html Blob -> iframed.
 * A recording_view_url, when present, is preferred over the FilePointer.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import BrowserAgentChip from '@/features/terminal-component-group/components/BrowserAgentChip';
import type { Message } from '@/lib/api';

// The stitched-MP4 path resolves a Supabase attachment URL, so stub the resolver.
vi.mock('@/lib/api/messages', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/messages')>()),
  getAttachmentUrl: vi.fn(async () => 'https://signed.example/stitched.mp4'),
}));

const TASK = 'browser-task-1';
const CALL = 'browser-call-1';
const KERNEL_VIEW_URL =
  'https://proxy.example.onkernel.com:8443/browser/replays?jwt=header.payload.sig&replay_id=rep-1';

function makeCtx(messages: Message[]): AgentContextValue {
  const streamedTextsRef = { current: new Set<string>() } as React.MutableRefObject<Set<string>>;
  return {
    agent: null,
    setAgent: () => {},
    selectedAgentId: 'agent-1',
    setSelectedAgentId: () => {},
    messages,
    setMessages: () => {},
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef,
    registerMessageHandler: () => () => {},
    sendMessage: async () => {},
    isLoadingAgent: false,
    forceResubscribe: () => {},
    isChatMode: false,
  } as AgentContextValue;
}

function renderChip(messages: Message[], anchor: Message) {
  return render(
    <AgentContext.Provider value={makeCtx(messages)}>
      <TooltipProvider>
        <BrowserAgentChip message={anchor} />
      </TooltipProvider>
    </AgentContext.Provider>,
  );
}

const anchorMsg: Message = {
  message_id: 'complete-1',
  timestamp: '2026-07-16T00:00:02Z',
  role: 'TOOL',
  text: '**Status**: ✅ SUCCESS',
  metadata: {
    task_id: TASK,
    toolCallId: CALL,
    toolName: 'spawn_browser_agent',
    action_type: 'task_complete',
  },
};

function recordingMsg(extra: Record<string, unknown>): Message {
  return {
    message_id: 'rec-1',
    timestamp: '2026-07-16T00:00:01Z',
    role: 'TOOL',
    text: 'Browser session replay recorded (Kernel).',
    metadata: {
      task_id: TASK,
      subAgentId: TASK,
      toolName: 'spawn_browser_agent',
      action_type: 'recording',
      toolStatus: 'FINISHED',
      ...extra,
    },
  };
}

async function openRecordingTab() {
  fireEvent.click(screen.getByTestId('browser-agent-chip-header'));
  await waitFor(() => expect(screen.getByText('Recording')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Recording'));
}

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
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
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
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    const video = (await screen.findByTitle('Browser recording')) as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.src).toBe('blob:stitched-recording');
    // Blobbed from a video/mp4 payload, and no per-segment playlist strip.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('recording-segments')).not.toBeInTheDocument();

    createObjSpy.mockRestore();
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

    // A non-interactive status strip shows the playhead (baseline first).
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

  it('shows "unavailable" when neither a view URL nor a file pointer is present', async () => {
    const messages = [anchorMsg, recordingMsg({})];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    expect(await screen.findByText('Recording unavailable for this run.')).toBeInTheDocument();
    expect(screen.queryByTitle('Browser recording')).not.toBeInTheDocument();
  });
});
