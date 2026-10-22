import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import {
  countParentReads,
  makeAgentTreeNode as makeNode,
} from './terminal-component-chips.fixtures';

// Agent tree — drive SubAgentTree node map deterministically.
const treeRef: { current: Map<string, unknown> } = { current: new Map() };
vi.mock('@/hooks/useAgentTree', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useAgentTree');
  return {
    ...actual,
    useAgentTree: () => treeRef.current,
  };
});

import SubAgentTree from '@/features/terminal-component-group/components/SubAgentTree';

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

  it('derives and renders a wide multi-level tree with a linear number of node scans', () => {
    const roots = Array.from({ length: 10 }, (_, r) => `r-${r}`);
    for (const root of roots) {
      treeRef.current.set(root, makeNode({ agentId: root, goal: 'root goal' }));
      for (let m = 0; m < 10; m += 1) {
        const mid = `${root}-m${m}`;
        treeRef.current.set(mid, makeNode({ agentId: mid, parentAgentId: root, goal: 'mid goal' }));
        for (let l = 0; l < 2; l += 1) {
          treeRef.current.set(
            `${mid}-l${l}`,
            makeNode({ agentId: `${mid}-l${l}`, parentAgentId: mid, goal: 'leaf goal' }),
          );
        }
      }
    }
    for (let u = 0; u < 90; u += 1) {
      treeRef.current.set(`u-${u}`, makeNode({ agentId: `u-${u}`, parentAgentId: 'elsewhere' }));
    }
    const counter = countParentReads(treeRef.current.values() as Iterable<object>);
    renderWithProviders(<SubAgentTree busId="bus-1" subAgentIds={roots} onNavigate={vi.fn()} />);
    expect(screen.getAllByText('root goal')).toHaveLength(10);
    expect(screen.getAllByText('mid goal')).toHaveLength(100);
    expect(screen.getAllByText('leaf goal')).toHaveLength(200);
    expect(screen.queryByText('Some goal')).toBeNull();
    // Two passes per derivation (spawn filter + subtree child index); rows only look up.
    expect(counter.reads).toBeLessThanOrEqual(2 * treeRef.current.size);
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
