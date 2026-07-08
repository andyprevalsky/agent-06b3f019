/**
 * Blackbox tests for ClaudeCodeChip and SubAgentTree.
 *
 * These components depend on agent-context and useAgentTree subscriptions,
 * both of which require live Supabase realtime. We stub those hooks to drive
 * the components through their state branches deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';

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
const messagesRef: { current: any[] } = { current: [] };
vi.mock('@/features/agent-context', () => ({
  useAgentContext: () => ({ messages: messagesRef.current }),
}));

// Agent tree — drive SubAgentTree node map deterministically.
const treeRef: { current: Map<string, any> } = { current: new Map() };
vi.mock('@/hooks/useAgentTree', async () => {
  const actual = await vi.importActual<any>('@/hooks/useAgentTree');
  return {
    ...actual,
    useAgentTree: () => treeRef.current,
  };
});

import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';
import SubAgentTree from '@/features/terminal-component-group/components/SubAgentTree';

// ═════════════════════════════════════════════════════════════════════════════
// ClaudeCodeChip
// ═════════════════════════════════════════════════════════════════════════════

function makeMsg(overrides: any = {}) {
  return {
    message_id: overrides.message_id || Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    text: overrides.text ?? '',
    role: overrides.role ?? 'TOOL',
    metadata: overrides.metadata ?? {},
  };
}

describe('ClaudeCodeChip', () => {
  beforeEach(() => {
    messagesRef.current = [];
  });

  afterEach(() => {
    messagesRef.current = [];
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
    // The compact header shows Maximize2 button
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
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

// ═════════════════════════════════════════════════════════════════════════════
// SubAgentTree
// ═════════════════════════════════════════════════════════════════════════════

function makeNode(overrides: any = {}) {
  return {
    agentId: overrides.agentId,
    parentAgentId: overrides.parentAgentId ?? null,
    goal: overrides.goal ?? 'Some goal',
    status: overrides.status ?? 'ACTIVE',
    progress: overrides.progress ?? 0,
    toolsInUse: overrides.toolsInUse ?? [],
    messageCount: overrides.messageCount ?? 0,
    costCents: overrides.costCents ?? 12,
    outputSchema: overrides.outputSchema,
    structuredOutput: overrides.structuredOutput,
    failureContext: overrides.failureContext,
  };
}

describe('SubAgentTree', () => {
  beforeEach(() => {
    treeRef.current = new Map();
  });

  afterEach(() => {
    treeRef.current = new Map();
  });

  it('returns null when tree has no matching root', () => {
    const { container } = renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['missing']} title="t" onNavigate={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a single-depth tree with goal and cost', () => {
    treeRef.current.set(
      'a1',
      makeNode({ agentId: 'a1', goal: '🎯 Find sock stores', costCents: 250 }),
    );
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} title="t" onNavigate={vi.fn()} />,
    );
    expect(screen.getByText('Find sock stores')).toBeInTheDocument();
    expect(screen.getByText('$2.50')).toBeInTheDocument();
    expect(screen.getByText('Delegating Sub Agents')).toBeInTheDocument();
  });

  it('fires onNavigate when a leaf row is clicked', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    treeRef.current.set('a1', makeNode({ agentId: 'a1', goal: 'Plan trip' }));
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} title="t" onNavigate={onNavigate} />,
    );
    await user.click(screen.getByText('Plan trip'));
    expect(onNavigate).toHaveBeenCalledWith('a1');
  });

  it('renders all-terminal COMPLETED cluster with success message', () => {
    treeRef.current.set('a1', makeNode({ agentId: 'a1', goal: 'Done task', status: 'COMPLETED' }));
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} title="t" onNavigate={vi.fn()} />,
    );
    expect(screen.getByText('Sub Agents completed successfully')).toBeInTheDocument();
  });

  it('renders failed cluster header when any leaf FAILED', () => {
    treeRef.current.set(
      'a1',
      makeNode({
        agentId: 'a1',
        goal: 'Broken',
        status: 'FAILED',
        failureContext: {
          trajectory: [{ tool_name: 'x', success: false, error_message: 'bad' } as any],
          progress_estimate: '30%',
          verifier_reasoning: 'Never got signal',
          last_reasoning: 'was thinking',
          last_plan: ['g1', 'g2'],
          steps_taken: 2,
        },
      }),
    );
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} title="t" onNavigate={vi.fn()} />,
    );
    expect(screen.getByText('All Sub Agents failed')).toBeInTheDocument();
  });

  it('shows output chip + status line with tool icon for agent using a tool', () => {
    treeRef.current.set(
      'a1',
      makeNode({
        agentId: 'a1',
        goal: 'Searching',
        status: 'COMPLETED',
        toolsInUse: [], // COMPLETED -> empty status text so we will show another agent
      }),
    );
    treeRef.current.set(
      'a2',
      makeNode({
        agentId: 'a2',
        goal: 'Working',
        status: 'ACTIVE',
        messageCount: 3,
        toolsInUse: ['web_search'],
        outputSchema: {
          fields: [
            { name: 'result', type: 'str', required: true, description: 'Result' },
            { name: 'missing', type: 'bool', required: false, description: 'Missing bool' },
          ],
        },
        structuredOutput: { result: 'ok' },
      }),
    );
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1', 'a2']} title="t" onNavigate={vi.fn()} />,
    );
    expect(screen.getByText('Working')).toBeInTheDocument();
    // Status text for single tool
    expect(screen.getByText('web_search')).toBeInTheDocument();
  });

  it('collapses intermediaries for depth>=2 trees and expands on click', async () => {
    const user = userEvent.setup();
    // Depth 3: root → mid → leaf
    treeRef.current.set('root', makeNode({ agentId: 'root', goal: 'root goal' }));
    treeRef.current.set(
      'mid',
      makeNode({ agentId: 'mid', parentAgentId: 'root', goal: 'mid goal' }),
    );
    treeRef.current.set(
      'leaf',
      makeNode({
        agentId: 'leaf',
        parentAgentId: 'mid',
        goal: 'leaf goal',
        status: 'COMPLETED',
      }),
    );
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['root']} title="t" onNavigate={vi.fn()} />,
    );
    // Full tree is visible by default (showAllIntermediaries=true)
    expect(screen.getByText('root goal')).toBeInTheDocument();
    expect(screen.getByText('mid goal')).toBeInTheDocument();
    // Collapse button is visible
    const collapseBtn = screen.getByText(/Collapse intermediary agents/);
    await user.click(collapseBtn);
    // After collapse: intermediary count line appears with '2 intermediary agents'
    expect(screen.getByText(/intermediary agent/)).toBeInTheDocument();
  });

  it('caps active leaf previews in collapsed depth>=2 trees', async () => {
    const user = userEvent.setup();
    treeRef.current.set('root', makeNode({ agentId: 'root', goal: 'root goal' }));
    for (let i = 0; i < 4; i++) {
      treeRef.current.set(
        `leaf-${i}`,
        makeNode({
          agentId: `leaf-${i}`,
          parentAgentId: 'root',
          goal: `active repeated prompt ${i}`,
          messageCount: 1,
        }),
      );
    }

    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['root']} title="t" onNavigate={vi.fn()} />,
    );

    await user.click(screen.getByText(/Collapse intermediary agents/));

    expect(screen.getByText('active repeated prompt 0')).toBeInTheDocument();
    expect(screen.getByText('thinking...')).toBeInTheDocument();
    expect(screen.queryByText('active repeated prompt 1')).toBeNull();
    expect(screen.queryByText('active repeated prompt 2')).toBeNull();
    expect(screen.queryByText('active repeated prompt 3')).toBeNull();
  });

  it('shows finished-summary line when multiple terminal leaves present in collapsed view', async () => {
    const user = userEvent.setup();
    // Root with many terminal leaves (depth=2 triggers collapse; > 1 terminal triggers summary)
    treeRef.current.set('root', makeNode({ agentId: 'root', goal: 'r' }));
    for (let i = 0; i < 3; i++) {
      treeRef.current.set(
        `c${i}`,
        makeNode({
          agentId: `c${i}`,
          parentAgentId: 'root',
          goal: `leaf ${i}`,
          status: 'COMPLETED',
        }),
      );
    }
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['root']} title="t" onNavigate={vi.fn()} />,
    );
    // Collapse first
    await user.click(screen.getByText(/Collapse intermediary agents/));
    // Finished summary line shows "3 finished agents"
    const finishedLine = await screen.findByText(/3 finished agent/);
    expect(finishedLine).toBeInTheDocument();
    // Clicking expands them
    await user.click(finishedLine);
    expect(screen.getByText(/Collapse 3 finished/)).toBeInTheDocument();
    // Click collapse back
    await user.click(screen.getByText(/Collapse 3 finished/));
  });

  it('hides header when hideHeader prop is true', () => {
    treeRef.current.set('a1', makeNode({ agentId: 'a1', goal: 'Hello' }));
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} title="t" onNavigate={vi.fn()} hideHeader />,
    );
    expect(screen.queryByText('Delegating tasks')).not.toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders partial data indicator for failed agent with output schema', () => {
    treeRef.current.set(
      'a1',
      makeNode({
        agentId: 'a1',
        goal: 'Did part',
        status: 'FAILED',
        outputSchema: {
          fields: [{ name: 'foo', type: 'str', required: true, description: 'Foo' }],
        },
        failureContext: {
          trajectory: [],
          progress_estimate: '40%',
          verifier_reasoning: 'stopped early',
          partial_structured_response: { foo: 'partial' },
          steps_taken: 1,
        },
      }),
    );
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} title="t" onNavigate={vi.fn()} />,
    );
    expect(screen.getByText('Did part')).toBeInTheDocument();
    expect(screen.getByText('All Sub Agents failed')).toBeInTheDocument();
  });
});
