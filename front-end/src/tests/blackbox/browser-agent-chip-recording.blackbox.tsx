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
  it('iframes the Kernel recording_view_url directly (no fetch)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const messages = [anchorMsg, recordingMsg({ recording_view_url: KERNEL_VIEW_URL })];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    const iframe = await screen.findByTitle('Browser recording');
    expect((iframe as HTMLIFrameElement).src).toBe(KERNEL_VIEW_URL);
    // Kernel replay is a hosted player — we must NOT hit the Supabase fetch path.
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

    const iframe = await screen.findByTitle('Browser recording');
    expect((iframe as HTMLIFrameElement).src).toBe(KERNEL_VIEW_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('shows "unavailable" when neither a view URL nor a file pointer is present', async () => {
    const messages = [anchorMsg, recordingMsg({})];
    renderChip(messages, anchorMsg);

    await openRecordingTab();

    expect(await screen.findByText('Recording unavailable for this run.')).toBeInTheDocument();
    expect(screen.queryByTitle('Browser recording')).not.toBeInTheDocument();
  });
});
