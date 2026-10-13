/**
 * Blackbox tests for ClaudeCodeChip and SubAgentTree.
 *
 * These components depend on agent-context and useAgentTree subscriptions,
 * both of which require live Supabase realtime. We stub those hooks to drive
 * the components through their state branches deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import {
  makeAgentTreeNode as makeNode,
  makeChipMessage as makeMsg,
} from './terminal-component-chips.fixtures';

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
vi.mock('@/features/agent-context', () => ({
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

// Agent tree — drive SubAgentTree node map deterministically.
const treeRef: { current: Map<string, unknown> } = { current: new Map() };
vi.mock('@/hooks/useAgentTree', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useAgentTree');
  return {
    ...actual,
    useAgentTree: () => treeRef.current,
  };
});

import ClaudeCodeChip from '@/features/terminal-component-group/components/ClaudeCodeChip';
import {
  formatTerminalOutputForDisplay,
  normalizeTerminalWhitespace,
} from '@/features/terminal-component-group/components/claudeCodeChip.terminal';
import { ParseCodeAgentTranscript as parseCodeAgentTranscript } from '@/features/terminal-component-group/components/claudeCodeChip.transcript';
import SubAgentTree from '@/features/terminal-component-group/components/SubAgentTree';

describe('code-agent terminal formatting', () => {
  it('adds readable ANSI section labels for terminal action markers', () => {
    const formatted = formatTerminalOutputForDisplay(
      '[Codex command output]\nhello\n[Codex exit code] 0',
    );

    expect(formatted).toContain('▶ Codex output');
    expect(formatted).toContain('✓ Codex exit');
    expect(formatted).toContain('\x1b[');
  });

  it('collapses runaway terminal indentation while preserving real code indentation', () => {
    const normalized = normalizeTerminalWhitespace(
      [
        'current = start',
        '                                                                                                while current <= end:',
        '    if weekday == 0:',
        '                                                                                                                         day_number = (current - start).days + 1',
      ].join('\n'),
    );

    expect(normalized).toContain('\n  while current <= end:');
    expect(normalized).toContain('\n    if weekday == 0:');
    expect(normalized).toContain('\n  day_number = (current - start).days + 1');
    expect(normalized).not.toMatch(/\n {24,}\S/);
  });

  it('parses completed code-agent output into color-coded transcript sections', () => {
    const blocks = parseCodeAgentTranscript(
      [
        `[Codex command started] /bin/bash -lc "python3 - <<'PY'"`,
        'from datetime import date, datetime',
        '[Codex command output]',
        'csv module parse: OK',
        'row_count=156',
        '[Codex exit_code] 0',
        '[Codex] Created and committed the calendar CSV.',
        'Artifacts:',
        '- `/home/user/content_calendar_90_days.csv`',
        'Verification:',
        '- `csv.DictReader`: OK',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      'command',
      'output',
      'exit',
      'agent',
      'status',
      'status',
    ]);
    expect(blocks.find((block) => block.kind === 'output')?.lines.join('\n')).toContain(
      'row_count=156',
    );
    expect(blocks.find((block) => block.title === 'Exited cleanly')?.tone).toBe('green');
  });

  it('parses Claude tool markers into icon tool rows instead of Claude notes', () => {
    const blocks = parseCodeAgentTranscript(
      [
        '[Claude] Session started in /home/user',
        "[Claude] I'll start by checking GitHub access.",
        '[Claude tool] Bash · gh auth status',
        '[Claude tool] Write · /home/user/discovery.py',
        '[Claude] Confirmed: unauthenticated access only.',
        '[Claude tool] Bash',
        '[Claude result] done',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      'agent',
      'tool',
      'tool',
      'agent',
      'tool',
      'result',
    ]);
    // Consecutive Claude notes merge into one coherent agent block.
    expect(blocks[0]?.lines.join('\n')).toContain('Session started in /home/user');
    expect(blocks[0]?.lines.join('\n')).toContain("I'll start by checking GitHub access.");
    expect(blocks[0]?.title).toBe('Claude');
    expect(blocks.find((block) => block.title === 'Bash')?.lines).toEqual(['gh auth status']);
    expect(blocks.find((block) => block.title === 'Write')?.lines).toEqual([
      '/home/user/discovery.py',
    ]);
    // Tools must not be swallowed under a "Claude note" dump.
    expect(blocks.some((block) => block.title === 'Claude note')).toBe(false);
  });

  it('heals staircase mid-token wraps so tool rows stay readable', () => {
    const blocks = parseCodeAgentTranscript(
      [
        '[Claude] Session started in /home/user',
        "                                      [Claude] I'll start by checking GitHub access.",
        '                                                           [Claude tool] Bas',
        'h',
        ' [Claude tool] Bash',
        '                   [Claude tool] Write',
        '[Claude] Now the discovery runner with checkpointi',
        'ng/resumability:',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual(['agent', 'tool', 'tool', 'tool', 'agent']);
    expect(blocks.filter((block) => block.kind === 'tool').map((block) => block.title)).toEqual([
      'Bash',
      'Bash',
      'Write',
    ]);
    expect(blocks[blocks.length - 1]?.lines.join('\n')).toContain(
      'discovery runner with checkpointing/resumability:',
    );
    expect(blocks.some((block) => block.title === 'Bas')).toBe(false);
    expect(blocks.some((block) => block.title === 'Claude note')).toBe(false);
  });

  it('preserves word boundaries when a wrapped tool name is followed by its detail', () => {
    const blocks = parseCodeAgentTranscript(
      ['[Claude tool] Bash', 'npm test --runInBand'].join('\n'),
    );
    const bash = blocks.find((block) => block.kind === 'tool' && block.title === 'Bash');
    expect(bash).toBeDefined();
    expect(bash?.lines).toEqual(['npm test --runInBand']);
    expect(blocks.some((block) => block.title === 'Bashnpm')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ClaudeCodeChip
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// SubAgentTree
// ═════════════════════════════════════════════════════════════════════════════

describe('SubAgentTree', () => {
  beforeEach(() => {
    treeRef.current = new Map();
  });

  afterEach(() => {
    treeRef.current = new Map();
  });

  // A known sub-agent id with no node data yet (REST snapshot + bus not populated)
  // stays VISIBLE ("spinning up...") instead of vanishing until refresh.
  it('shows a pending placeholder for a known sub-agent id with no node data yet', () => {
    const { container } = renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['missing']} onNavigate={vi.fn()} />,
    );
    expect(container.firstChild).not.toBeNull();
    expect(container.textContent).toContain('spinning up...');
  });

  it('renders a single-depth tree with goal and cost', () => {
    treeRef.current.set(
      'a1',
      makeNode({ agentId: 'a1', goal: '🎯 Find sock stores', costCents: 250 }),
    );
    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={['a1']} onNavigate={vi.fn()} />);
    expect(screen.getByText('Find sock stores')).toBeInTheDocument();
    expect(screen.getByText('$2.50')).toBeInTheDocument();
    expect(screen.getByText('Delegating Sub Agents')).toBeInTheDocument();
  });

  it('fires onNavigate when a leaf row is clicked', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    treeRef.current.set('a1', makeNode({ agentId: 'a1', goal: 'Plan trip' }));
    renderWithProviders(
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} onNavigate={onNavigate} />,
    );
    await user.click(screen.getByText('Plan trip'));
    expect(onNavigate).toHaveBeenCalledWith('a1');
  });

  it('renders all-terminal COMPLETED cluster with success message', () => {
    treeRef.current.set('a1', makeNode({ agentId: 'a1', goal: 'Done task', status: 'COMPLETED' }));
    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={['a1']} onNavigate={vi.fn()} />);
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
          trajectory: [{ tool_name: 'x', success: false, error_message: 'bad' } as never],
          progress_estimate: '30%',
          verifier_reasoning: 'Never got signal',
          last_reasoning: 'was thinking',
          last_plan: ['g1', 'g2'],
          steps_taken: 2,
        },
      }),
    );
    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={['a1']} onNavigate={vi.fn()} />);
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
      <SubAgentTree busId="bus-1" subAgentIds={['a1', 'a2']} onNavigate={vi.fn()} />,
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
    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={['root']} onNavigate={vi.fn()} />);
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

    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={['root']} onNavigate={vi.fn()} />);

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
    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={['root']} onNavigate={vi.fn()} />);
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
      <SubAgentTree busId="bus-1" subAgentIds={['a1']} onNavigate={vi.fn()} hideHeader />,
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
    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={['a1']} onNavigate={vi.fn()} />);
    expect(screen.getByText('Did part')).toBeInTheDocument();
    expect(screen.getByText('All Sub Agents failed')).toBeInTheDocument();
  });
});
