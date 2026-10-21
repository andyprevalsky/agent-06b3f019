/**
 * Blackbox tests for ClaudeCodeChip.
 *
 * The component depends on agent-context and live Supabase realtime.
 * We stub those dependencies to drive its state branches deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import { makeChipMessage as makeMsg } from './terminal-component-chips.fixtures';

// ── Mocks (must be hoisted before the module-under-test imports) ─────────────

// Stub xterm so ClaudeCodeChip can mount inside jsdom without touching real DOM.
vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  }
  return { Terminal: FakeTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FakeFit {
    fit() {}
  }
  return { FitAddon: FakeFit };
});

// Supabase is imported by ClaudeCodeChip for the signed-URL fetch and session.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/file' } }),
      }),
    },
  },
  getSession: () => null,
}));

// Agent context — drive ClaudeCodeChip messages deterministically.
const messagesRef: { current: unknown[] } = { current: [] };
const agentRef: { current: { status?: string } | null } = { current: null };
vi.mock('@/features/agent-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/agent-context')>()),
  useAgentContext: () => ({ messages: messagesRef.current, agent: agentRef.current }),
}));

const fetchCodeAgentSessionMock =
  vi.fn<
    (taskId: string, codeProvider?: string) => Promise<{ output?: string; status?: string } | null>
  >();
vi.mock('@/features/terminal-component-group/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/terminal-component-group/api')>();
  return {
    ...actual,
    fetchCodeAgentSession: (taskId: string, codeProvider?: string) =>
      fetchCodeAgentSessionMock(taskId, codeProvider),
  };
});

import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';

// ═════════════════════════════════════════════════════════════════════════════
// ClaudeCodeChip
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// ClaudeCodeChip
// ═════════════════════════════════════════════════════════════════════════════

describe('ClaudeCodeChip', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    messagesRef.current = [];
    agentRef.current = null;
    fetchCodeAgentSessionMock.mockReset();
    fetchCodeAgentSessionMock.mockResolvedValue(null);
    globalThis.WebSocket = originalWebSocket;
  });

  afterEach(() => {
    messagesRef.current = [];
    agentRef.current = null;
    fetchCodeAgentSessionMock.mockReset();
    globalThis.WebSocket = originalWebSocket;
  });

  it('renders the spinning up state by default', () => {
    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.getByText('Claude Code Spinning up...')).toBeInTheDocument();
  });

  it('renders Codex when the code provider is Codex', () => {
    renderWithProviders(<ClaudeCodeChip taskId="task-1" codeProvider="codex" />);
    expect(screen.getByText('Codex Spinning up...')).toBeInTheDocument();
    expect(screen.getByAltText('Codex')).toBeInTheDocument();
  });

  it('renders spinning_up with forceShow terminal surface', () => {
    renderWithProviders(<ClaudeCodeChip taskId="task-1" forceShow />);
    expect(screen.getByText('Claude Code Spinning up...')).toBeInTheDocument();
    // Turn-count chip temporarily removed (code-agent verifier kill-switch work).
    expect(screen.queryByText(/turns? completed/)).not.toBeInTheDocument();
    // The compact header shows Maximize2 button
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('does not show a turn-count chip for heartbeat progress messages', () => {
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'task_started',
          title: 'Task Started',
          toolStatus: 'FINISHED',
        },
      }),
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'agent_observation',
          title: 'Claude Code working (30s)',
          toolStatus: 'FINISHED',
        },
      }),
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'agent_observation',
          title: 'Claude Code working (60s)',
          toolStatus: 'FINISHED',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" forceShow />);
    expect(screen.queryByText(/turns? completed/)).not.toBeInTheDocument();
  });

  it('does not show a turn-count chip for Codex completed_turns metadata', () => {
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'claude_code_started',
          title: 'Codex Code Started',
          code_provider: 'codex',
        },
      }),
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'agent_observation',
          title: 'Codex working (30s)',
          toolStatus: 'FINISHED',
          code_provider: 'codex',
          completed_turns: 1,
        },
      }),
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'agent_observation',
          title: 'Codex working (60s)',
          toolStatus: 'FINISHED',
          code_provider: 'codex',
          completed_turns: 1,
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" forceShow codeProvider="codex" />);
    expect(screen.queryByText(/turns? completed/)).not.toBeInTheDocument();
  });

  it('shows completed state and structured response when expanded', async () => {
    const user = userEvent.setup();
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          output_schema: {
            fields: [
              { name: 'summary', type: 'str', required: true, description: 'Summary field' },
              { name: 'count', type: 'int', required: false, description: 'Count field' },
            ],
          },
          github_repo_url: 'https://github.com/example/repo',
        },
      }),
      makeMsg({
        text: 'Done!',
        metadata: {
          task_id: 'task-1',
          action_type: 'task_complete',
          title: 'Task Completed',
          structured_response: { summary: 'ok', count: 3, missing: null, arr: [1, 2] },
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.getByText('Claude Code Completed Successfully')).toBeInTheDocument();
    expect(screen.getByText('Repo')).toBeInTheDocument();

    // Expand the chip
    await user.click(screen.getByText('Claude Code Completed Successfully'));
    expect(screen.getByText('Extracted Output')).toBeInTheDocument();
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('Count')).toBeInTheDocument();
  });

  it('treats Codex Task Complete messages with success status as completed', () => {
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'claude_code_started',
          title: 'Codex Code Started',
          code_provider: 'codex',
        },
      }),
      makeMsg({
        text: '**Status**: ✅ SUCCESS\n\nVerification passed.',
        metadata: {
          task_id: 'task-1',
          action_type: 'task_complete',
          title: 'Task Complete',
          toolStatus: 'FINISHED',
          code_provider: 'codex',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.getByText('Codex Completed Successfully')).toBeInTheDocument();
    expect(screen.queryByText('Codex Failed')).not.toBeInTheDocument();
  });

  it('does not flash failed from a raw non-zero WebSocket exit before Codex verifier success', async () => {
    const socket: {
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onclose: (() => void) | null;
      readyState: number;
      close: () => void;
    } = {
      onopen: null,
      onmessage: null,
      onclose: null,
      readyState: 1,
      close: () => {
        socket.readyState = 3;
        socket.onclose?.();
      },
    };
    function MockWebSocket() {
      return socket;
    }
    Object.assign(MockWebSocket, { OPEN: 1 });

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const { rerender } = renderWithProviders(
      <ClaudeCodeChip taskId="task-1" wsUrl="ws://example.test" codeProvider="codex" forceShow />,
    );

    act(() => {
      socket.onopen?.();
    });
    expect(screen.getByText('Codex Active')).toBeInTheDocument();

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 1 }) });
    });

    await waitFor(() => expect(screen.getByText('Verifying Result...')).toBeInTheDocument());
    expect(screen.queryByText('Codex Failed')).not.toBeInTheDocument();

    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'claude_code_started',
          title: 'Codex Code Started',
          code_provider: 'codex',
        },
      }),
      makeMsg({
        text: '**Status**: ✅ SUCCESS\n\nVerification passed.',
        metadata: {
          task_id: 'task-1',
          action_type: 'task_complete',
          title: 'Task Complete',
          toolStatus: 'FINISHED',
          code_provider: 'codex',
        },
      }),
    ];

    rerender(
      <ClaudeCodeChip taskId="task-1" wsUrl="ws://example.test" codeProvider="codex" forceShow />,
    );

    await waitFor(() =>
      expect(screen.getByText('Codex Completed Successfully')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Codex Failed')).not.toBeInTheDocument();
  });

  it('shows failed state with failure message when expanded', async () => {
    const user = userEvent.setup();
    messagesRef.current = [
      makeMsg({
        text: 'Something broke',
        metadata: {
          task_id: 'task-1',
          toolStatus: 'ERROR',
        },
      }),
      makeMsg({
        text: 'Task failed',
        metadata: {
          task_id: 'task-1',
          action_type: 'task_complete',
          title: 'Task Incomplete',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.getByText('Claude Code Failed')).toBeInTheDocument();

    await user.click(screen.getByText('Claude Code Failed'));
    expect(screen.getByText('Something broke')).toBeInTheDocument();
  });

  it('clears spinning_up on pause cancel task_complete (Session Cancelled)', () => {
    // Mirrors the durable pause path: activity/handler posts task_complete titled
    // Session Cancelled. Without this, the chip stays on Spinning up forever.
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'claude_code_started',
          title: 'Claude Code Started',
          ws_url: 'wss://example.test',
        },
      }),
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'agent_observation',
          title: 'Claude Code working (842s)',
          toolStatus: 'FINISHED',
        },
      }),
      makeMsg({
        text: 'User paused the agent',
        metadata: {
          task_id: 'task-1',
          action_type: 'task_complete',
          title: 'Session Cancelled',
          toolStatus: 'ERROR',
          success: false,
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.queryByText('Claude Code Spinning up...')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Code Failed')).toBeInTheDocument();
  });

  it('closes spinning chip when ClaudeCodeSession is CLOSED without task_complete', async () => {
    fetchCodeAgentSessionMock.mockResolvedValue({
      status: 'CLOSED',
      output: '[Claude tool] Bash · ls\n',
    });
    agentRef.current = { status: 'FAILED' };
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-closed',
          action_type: 'claude_code_started',
          title: 'Claude Code Started',
        },
      }),
      makeMsg({
        metadata: {
          task_id: 'task-closed',
          action_type: 'agent_observation',
          title: 'Claude Code working (30s)',
          toolStatus: 'FINISHED',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-closed" />);
    expect(screen.getByText('Claude Code Spinning up...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText('Claude Code Spinning up...')).not.toBeInTheDocument();
      expect(screen.getByText('Claude Code Failed')).toBeInTheDocument();
    });
  });

  it('marks closed session successful when root agent status is COMPLETED', async () => {
    fetchCodeAgentSessionMock.mockResolvedValue({ status: 'CLOSED', output: '[Claude] done\n' });
    agentRef.current = { status: 'COMPLETED' };
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-closed-ok',
          action_type: 'claude_code_started',
          title: 'Claude Code Started',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-closed-ok" />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code Completed Successfully')).toBeInTheDocument();
    });
  });

  it('keeps cancel terminal after a late agent_observation heartbeat', () => {
    // Prod race: heartbeat can land after cancel (agent_logs showed working 872s
    // after Session Cancelled). Terminality must be sticky.
    messagesRef.current = [
      makeMsg({
        text: 'User paused the agent',
        metadata: {
          task_id: 'task-1',
          action_type: 'task_complete',
          title: 'Session Cancelled',
          toolStatus: 'ERROR',
          success: false,
        },
      }),
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'agent_observation',
          title: 'Claude Code working (872s)',
          toolStatus: 'FINISHED',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.queryByText('Claude Code Spinning up...')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Code Failed')).toBeInTheDocument();
  });

  it('treats legacy session_cancelled with task_id as terminal', () => {
    messagesRef.current = [
      makeMsg({
        text: 'User paused the agent',
        metadata: {
          task_id: 'task-1',
          action_type: 'session_cancelled',
          title: 'Claude Code Session Cancelled',
          toolStatus: 'ERROR',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.queryByText('Claude Code Spinning up...')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Code Failed')).toBeInTheDocument();
  });

  it('treats bare session_cancelled sharing toolCallId as terminal', () => {
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          toolCallId: 'tc-cancel-1',
          action_type: 'claude_code_started',
          title: 'Claude Code Started',
        },
      }),
      makeMsg({
        text: 'User paused the agent',
        metadata: {
          // No task_id — handler cancel race; only toolCallId links it.
          toolCallId: 'tc-cancel-1',
          action_type: 'session_cancelled',
          title: 'Claude Code Session Cancelled',
          toolStatus: 'ERROR',
        },
      }),
    ];

    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);
    expect(screen.queryByText('Claude Code Spinning up...')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Code Failed')).toBeInTheDocument();
  });

  it('renders verifying state from system message metadata', () => {
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'system',
          title: 'Verifying Result',
          toolStatus: 'IN_PROGRESS',
        },
      }),
    ];
    renderWithProviders(<ClaudeCodeChip taskId="task-1" wsUrl="ws://fake/ws" />);
    expect(screen.getByText('Verifying Result...')).toBeInTheDocument();
  });

  it('opens fullscreen when maximize clicked in completed collapsed chip', async () => {
    const user = userEvent.setup();
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          action_type: 'task_complete',
          title: 'Task Completed',
        },
      }),
    ];
    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);

    const buttons = screen.getAllByRole('button');
    // first button inside the chip is the Maximize2 trigger (stops propagation)
    await user.click(buttons[0]);

    // Fullscreen renders status and the close X button (via portal → still in document)
    expect(screen.getAllByText('Claude Code Completed Successfully').length).toBeGreaterThan(0);
  });

  it('hovering the schema chip reveals the output schema tooltip', async () => {
    messagesRef.current = [
      makeMsg({
        metadata: {
          task_id: 'task-1',
          output_schema: {
            fields: [
              { name: 'city', type: 'str', required: true, description: 'City name' },
              { name: 'ids', type: 'list[int]', required: false, description: 'Ids' },
              { name: 'doc', type: 'file_pointer', required: false, description: 'Doc' },
            ],
          },
        },
      }),
    ];
    renderWithProviders(<ClaudeCodeChip taskId="task-1" />);

    // Schema trigger — only one FileJson inside the chip (spinning_up branch)
    const triggers = document.querySelectorAll('.lucide-file-json');
    expect(triggers.length).toBeGreaterThan(0);
    fireEvent.mouseEnter(triggers[0].parentElement!.parentElement!);
    expect(screen.getByText('Output Schema')).toBeInTheDocument();
    expect(screen.getByText('city')).toBeInTheDocument();
    fireEvent.mouseLeave(triggers[0].parentElement!.parentElement!);
  });
});
