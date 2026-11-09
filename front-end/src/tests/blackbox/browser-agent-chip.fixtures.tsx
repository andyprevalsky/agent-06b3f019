/**
 * Shared BrowserAgentChip render helpers for the recording blackbox suites.
 */
import React from 'react';
import { expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import BrowserAgentChip from '@/features/terminal-component-group/components/BrowserAgentChip';
import type { Message } from '@/lib/api';

export const TASK = 'browser-task-1';
export const CALL = 'browser-call-1';
export const KERNEL_VIEW_URL =
  'https://proxy.example.onkernel.com:8443/browser/replays?jwt=header.payload.sig&replay_id=rep-1';

export function makeCtx(messages: Message[]): AgentContextValue {
  const streamedTextsRef = { current: new Set<string>() } as React.MutableRefObject<Set<string>>;
  return {
    agent: null,
    applyAgentDetail: () => true,
    selectedAgentId: 'agent-1',
    setSelectedAgentId: () => {},
    messages,
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
    inspectionContext: null,
    stagePendingAgentCreation: () => {},
    reconcilePendingAgentCreation: async () => {},
    rollbackPendingAgentCreation: () => false,
    stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
  };
}

export function chipElement(messages: Message[], anchor: Message) {
  return (
    <AgentContext.Provider value={makeCtx(messages)}>
      <TooltipProvider>
        <BrowserAgentChip message={anchor} />
      </TooltipProvider>
    </AgentContext.Provider>
  );
}

export function renderChip(messages: Message[], anchor: Message) {
  return render(chipElement(messages, anchor));
}

export const anchorMsg: Message = {
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

export function recordingMsg(extra: Record<string, unknown>): Message {
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

export function recordingMsgWithId(
  messageId: string,
  timestamp: string,
  extra: Record<string, unknown>,
): Message {
  return {
    ...recordingMsg(extra),
    message_id: messageId,
    timestamp,
  };
}

export async function openRecordingTab() {
  fireEvent.click(screen.getByTestId('browser-agent-chip-header'));
  await waitFor(() => expect(screen.getByText(/^Recording/)).toBeInTheDocument());
  fireEvent.click(screen.getByText(/^Recording/));
}
