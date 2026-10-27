import { describe, expect, it, vi } from 'vitest';
import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import { makeChipMessage as makeMsg } from './terminal-component-chips.fixtures';

const { fetchSession, messages } = vi.hoisted(() => ({
  fetchSession: vi.fn().mockResolvedValue(null),
  messages: { current: [] as unknown[] },
}));
vi.mock('@/features/agent-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/agent-context')>()),
  useAgentContext: () => ({ messages: messages.current, agent: null }),
}));
vi.mock('@/features/terminal-component-group/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/terminal-component-group/api')>()),
  fetchCodeAgentSession: fetchSession,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

import {
  useClaudeCodeChip,
  useClaudeCodeChipState,
} from '@/features/terminal-component-group/components/claudeCodeChip.hooks';
import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { useFilteredMessages } from '@/features/terminal-component-group/components/useMessageFiltering';
import type { Message } from '@/features/terminal-component-group/hooks';

export function RecordedTranscript() {
  const { filteredMessagesRaw } = useFilteredMessages(messages.current as Message[], undefined);
  return (
    <>
      {filteredMessagesRaw.map((message) => (
        <MessageBubble key={message.message_id} message={message} />
      ))}
    </>
  );
}

describe('WMH code completion in a durable transcript', () => {
  it('shows the completed predicted result without fetching a nonexistent real session', async () => {
    messages.current = [
      makeMsg({
        text: 'Four draft fundraising files created; no investors were contacted.',
        metadata: {
          toolName: 'spawn_claude_code_agent',
          task_id: 'wmh-code',
          taskId: 'wmh-code',
          action_type: 'task_complete',
          title: '✓ Task Completed',
          toolStatus: 'FINISHED',
          success: true,
          world_model_simulated: true,
        },
      }),
    ];
    fetchSession.mockClear();
    renderWithProviders(<ClaudeCodeChip taskId="wmh-code" />);
    expect(screen.queryByText('Claude Code Spinning up...')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByText('Claude Code Completed Successfully'));
    expect(
      screen.getByText('Four draft fundraising files created; no investors were contacted.'),
    ).toBeInTheDocument();
    expect(fetchSession).not.toHaveBeenCalled();
  });
  it('renders the recorded legacy WMH lifecycle as one completed expandable code chip', async () => {
    const taskId = '857fa645-414a-4967-9f02-3be72bd1e0c3';
    const metadata = {
      toolName: 'spawn_agent',
      agentType: 'code',
      taskId,
      toolCallId: 'fbc00b72-2e82-41dd-81ff-6626c0e3127d',
      world_model_boundary: 'spawn_claude_code_agent',
      world_model_simulated: true,
    };
    const output =
      '**Status**: ✅ SUCCESS\n\n**Outcome**: The code agent created four draft fundraising files.';
    messages.current = [
      makeMsg({
        text: 'Starting code agent',
        metadata: {
          toolName: 'spawn_claude_code_agent',
          toolCallId: metadata.toolCallId,
          title: 'Starting code agent',
          toolStatus: 'IN_PROGRESS',
        },
      }),
      makeMsg({
        text: 'Create a concise, investor-ready Rose Labs fundraising package',
        metadata: { ...metadata, title: 'Code agent', toolStatus: 'IN_PROGRESS' },
      }),
      makeMsg({
        text: output,
        metadata: { ...metadata, title: 'Code agent complete', toolStatus: 'FINISHED' },
      }),
    ];
    fetchSession.mockClear();
    renderWithProviders(<RecordedTranscript />);
    expect(screen.getAllByText('Claude Code Completed Successfully')).toHaveLength(1);
    expect(screen.queryByText('Claude Code Spinning up...')).not.toBeInTheDocument();
    expect(screen.queryByText('Code agent complete')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByText('Claude Code Completed Successfully'));
    expect(
      screen.getByText(/The code agent created four draft fundraising files/),
    ).toBeInTheDocument();
    expect(fetchSession).not.toHaveBeenCalled();
  });
});

describe('WMH terminal output survives later lifecycle messages', () => {
  it.each([true, false])(
    'keeps the recorded output when a later cancellation has task_id=%s',
    async (includeTaskId) => {
      messages.current = [
        makeMsg({
          text: 'Predicted code output',
          metadata: {
            task_id: 'wmh-sticky',
            toolCallId: 'sticky-call',
            action_type: 'task_complete',
            title: 'Task Completed',
            world_model_simulated: true,
          },
        }),
        makeMsg({
          text: 'Unrelated predicted output',
          metadata: {
            task_id: 'other-task',
            toolCallId: 'other-call',
            action_type: 'task_complete',
            world_model_simulated: true,
          },
        }),
        makeMsg({
          text: 'Session cancelled',
          metadata: {
            ...(includeTaskId ? { task_id: 'wmh-sticky' } : {}),
            toolCallId: 'sticky-call',
            action_type: 'session_cancelled',
          },
        }),
      ];
      fetchSession.mockClear();
      const { result } = renderHook(() => useClaudeCodeChip('wmh-sticky', undefined, false));
      expect(result.current.isComplete).toBe(true);
      expect(result.current.isSuccess).toBe(false);
      expect(result.current.terminalTranscript).toBe('Predicted code output');
      await Promise.resolve();
      expect(fetchSession).not.toHaveBeenCalled();
    },
  );

  it('uses the normalized terminal contract once for a legacy cancel sibling', () => {
    messages.current = [
      makeMsg({
        text: '**Status**: ✅ SUCCESS\nRecorded result',
        metadata: {
          taskId: 'legacy-cancel',
          toolCallId: 'legacy-call',
          toolName: 'spawn_agent',
          world_model_boundary: 'spawn_claude_code_agent',
          world_model_simulated: true,
          toolStatus: 'FINISHED',
          action_type: 'session_cancelled',
        },
      }),
    ];
    const { result } = renderHook(() => useClaudeCodeChipState('legacy-cancel'));
    expect(result.current.isComplete).toBe(true);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.simulatedOutput).toBe('**Status**: ✅ SUCCESS\nRecorded result');
  });

  it('trusts the terminal status and success flag over failure words in the output', () => {
    const quoted =
      'Summary of the incident report:\nTask Failed was logged once. FAILED retries: 0.';
    messages.current = [
      makeMsg({
        text: quoted,
        metadata: {
          taskId: 'legacy-quoted',
          toolCallId: 'legacy-quoted-call',
          toolName: 'spawn_agent',
          world_model_boundary: 'spawn_claude_code_agent',
          world_model_simulated: true,
          toolStatus: 'FINISHED',
        },
      }),
      makeMsg({
        text: quoted,
        metadata: {
          task_id: 'flagged-success',
          action_type: 'task_complete',
          title: '✓ Task Completed',
          toolStatus: 'FINISHED',
          success: true,
        },
      }),
      makeMsg({
        text: 'All files written.',
        metadata: {
          task_id: 'flagged-failure',
          action_type: 'task_complete',
          title: '✓ Task Completed',
          toolStatus: 'FINISHED',
          success: false,
        },
      }),
    ];
    const state = (taskId: string) =>
      renderHook(() => useClaudeCodeChipState(taskId)).result.current;
    expect(state('legacy-quoted')).toMatchObject({ isComplete: true, isSuccess: true });
    expect(state('flagged-success')).toMatchObject({ isComplete: true, isSuccess: true });
    expect(state('flagged-failure')).toMatchObject({ isComplete: true, isSuccess: false });
  });

  it('continues fetching saved output for an ordinary real completed session', async () => {
    messages.current = [
      makeMsg({
        text: 'Done',
        metadata: {
          task_id: 'real-complete',
          action_type: 'task_complete',
          title: 'Task Completed',
        },
      }),
    ];
    fetchSession.mockClear();
    const { result } = renderHook(() => useClaudeCodeChip('real-complete', undefined, false));
    expect(result.current.simulatedOutput).toBeUndefined();
    await waitFor(() => expect(fetchSession).toHaveBeenCalledWith('real-complete', 'claude'));
  });
});
