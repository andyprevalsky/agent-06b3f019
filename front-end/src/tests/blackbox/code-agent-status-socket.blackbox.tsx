/**
 * Blackbox: the stock code-agent chip's controls and its status-only socket.
 *   Flag off: Maximize is a named button.
 *   A work slot's pager is a labelled navigation with a polite page status.
 *   Rose Desktop without a snapshot: the terminal socket still carries lifecycle
 *   (live → completed) but keeps no terminal output (nothing displays it).
 *   The transcript-only code-agent view's socket likewise keeps no output.
 */
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, within } from '@testing-library/react';

import { WorkHistoryPager } from '@/features/terminal-component-group/components/WorkHistoryPager';
import { useClaudeCodeChip } from '@/features/terminal-component-group/components/claudeCodeChip.hooks';
import { useCodeAgentConversation } from '@/features/terminal-component-group/components/code-agent-view/useCodeAgentConversation';
import type { Message } from '@/lib/api';

import { ROOT_AGENT_ID, WithAgent, msg, renderChip } from './code-agent-steering.fixtures';

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

const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe('stock code-agent chip controls and status socket', () => {
  it('the stock Maximize button has an accessible name (flag off)', () => {
    renderChip(
      [msg({ task_id: 'task-1', action_type: 'task_complete', title: 'Task Completed' })],
      false,
    );
    const maximize = screen.getByRole('button', { name: 'Maximize Claude Code' });
    expect(maximize).toHaveAttribute('type', 'button');
  });

  it('the work history pager is a labelled navigation with a polite page status', () => {
    render(createElement(WorkHistoryPager, { activePage: 0, lastPage: 2, setPage: vi.fn() }));
    const pager = screen.getByRole('navigation', { name: 'Work history pages' });
    const status = within(pager).getByRole('status');
    expect(status).toHaveTextContent('1 / 3');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('a status-only socket keeps lifecycle transitions but buffers no terminal output', () => {
    const socket = drivenSocket();
    const { result } = renderHook(
      () =>
        useClaudeCodeChip('task-1', 'ws://example.test', false, 'claude', {
          savedOutput: false,
          terminalOutput: false,
        }),
      { wrapper: withMessages([]) },
    );
    act(() => socket.onopen?.());
    expect(result.current.chipState).toBe('live');
    sendTerminalBytes(socket);
    act(() => result.current.toggleExpand());
    expect(result.current.terminalTranscript).toBe('');
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) }));
    expect(result.current.chipState).toBe('completed');
  });

  it('the transcript-only code-agent view keeps its live socket but buffers no terminal output', () => {
    // Legacy rows (no code_agent snapshot): the view opens the session socket
    // for lifecycle only; it mounts no terminal, so it keeps none of its bytes.
    const socket = drivenSocket();
    const rows = [msg({ task_id: 'task-1', ws_url: 'ws://example.test' })];
    const { result } = renderHook(
      () =>
        useCodeAgentConversation({
          taskId: 'task-1',
          ownerAgentId: ROOT_AGENT_ID,
          provider: 'claude',
          title: 'Polish the sidebar',
          status: 'ACTIVE',
        }),
      { wrapper: withMessages(rows) },
    );
    expect(result.current.meta).toBeNull();
    act(() => socket.onopen?.());
    expect(result.current.chipState).toBe('live');
    sendTerminalBytes(socket);
    act(() => result.current.vm.toggleExpand());
    expect(result.current.vm.terminalTranscript).toBe('');
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) }));
    expect(result.current.stateText).toBe('Completed');
  });
});

interface DrivenSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  readyState: number;
  close: () => void;
}

/** Replaces WebSocket with one socket the test drives by hand. */
function drivenSocket(): DrivenSocket {
  const socket: DrivenSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    readyState: 1,
    close: () => {},
  };
  function DrivenWebSocket() {
    return socket;
  }
  Object.assign(DrivenWebSocket, { OPEN: 1 });
  globalThis.WebSocket = DrivenWebSocket as unknown as typeof WebSocket;
  return socket;
}

/** Terminal output in both socket framings (JSON stdout and raw bytes). */
function sendTerminalBytes(socket: DrivenSocket) {
  act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'stdout', data: 'SECRET' }) }));
  act(() => socket.onmessage?.({ data: 'raw SECRET bytes' }));
}

function withMessages(messages: Message[]) {
  return ({ children }: { children: ReactNode }) =>
    createElement(WithAgent, { messages }, children);
}
