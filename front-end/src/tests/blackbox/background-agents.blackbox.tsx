/**
 * Blackbox tests for background spawn chips + the running-agents dock.
 *
 *  - Grouping keys off the ORIGINAL toolCallId: UI rows posted under it with
 *    `excludeFromModel`, the hidden model-facing "Started…" row
 *    (`runInBackground`), for_each children `<id>:<idx>`, and completion rows
 *    via `backgroundTaskId`.
 *  - Trajectory: background spawns render with main's spawn UI unchanged
 *    (SubAgentTree / explore bubble); live rows survive later parent thoughts.
 *  - Dock: counts running descendants + in-activity tasks, expands to the
 *    SubAgentTree hierarchy, navigates on agent rows, sits flush on the input,
 *    and shows output schemas (per agent, and a results table per for_each).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { BackgroundAgentsBanner } from '@/features/terminal-component-group/components/background-agents/BackgroundAgentsBanner';
import { deriveBackgroundSpawns } from '@/features/terminal-component-group/hooks/backgroundSpawns';
import type { Message } from '@/lib/api';
import { makeAgentCtx } from './message-bubble.fixtures';
import { makeAgentTreeNode } from './terminal-component-chips.fixtures';

const tree = vi.hoisted(() => ({ nodes: new Map<string, unknown>() }));
vi.mock('@/hooks/useAgentTree', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useAgentTree');
  return { ...actual, useAgentTree: (busId: string | null) => (busId ? tree.nodes : new Map()) };
});
vi.mock('@/components/ThinkingAnimation', () => ({ default: () => <div /> }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
});
beforeEach(() => {
  tree.nodes = new Map();
});

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
let seq = 0;
function row(
  metadata: Record<string, unknown>,
  text = '',
  role: Message['role'] = 'TOOL',
): Message {
  seq += 1;
  return {
    message_id: `m-${seq}`,
    timestamp: new Date(T0 + seq * 1000).toISOString(),
    role,
    text,
    metadata,
  };
}

function started(callId: string, type: string, path: string, goal: string): Message {
  return row(
    {
      toolCallId: callId,
      toolName: 'spawn_agent',
      toolStatus: 'FINISHED',
      hidden: true,
      runInBackground: true,
      backgroundAddress: path,
      backgroundPath: path,
      backgroundGoal: goal,
      backgroundAgentType: type,
    },
    'Started',
  );
}

function live(callId: string, extra: Record<string, unknown>): Message {
  return row({
    toolCallId: callId,
    toolName: 'spawn_general_purpose_agent',
    toolStatus: 'IN_PROGRESS',
    excludeFromModel: true,
    busId: 'root-1',
    ...extra,
  });
}

function done(callId: string, path: string, status: string, body: string): Message {
  return row(
    {
      agentNotification: true,
      toolName: 'agent_notification',
      fromAgentAddress: path,
      status,
      backgroundTaskId: callId,
    },
    `Message Type: ${status === 'failed' ? 'FAILED' : 'FINAL_ANSWER'}\nTask name: x\nSender: ${path}\nPayload:\n${body}`,
    'USER',
  );
}

const gp = () => [
  started('call_gp', 'general_purpose', '/root/budget_planner', 'Draft a rough budget'),
  live('call_gp', { subAgentIds: ['child-1'], spawnGroupId: 'call_gp' }),
];
const forEach = () => [
  started('call_fe', 'for_each', '/root/venue_capacities', 'Look up each venue'),
  live('call_fe:0', { subAgentIds: ['fe-a'] }),
  live('call_fe:1', { subAgentIds: ['fe-b'] }),
  live('call_fe:2', { subAgentIds: ['fe-c'] }),
];
const explore = () => [
  started('call_ex', 'explore', '/root/hotel_price', 'Find the average hotel price'),
  row({
    toolCallId: 'call_ex',
    toolName: 'spawn_agent',
    toolStatus: 'IN_PROGRESS',
    excludeFromModel: true,
    agentType: 'explore',
    taskId: 't-ex',
    title: 'Exploring',
  }),
];

function renderList(messages: Message[], onNavigateToAgent = vi.fn()) {
  return render(
    <AgentContext.Provider value={makeAgentCtx({ selectedAgentId: 'root-1', messages })}>
      <TooltipProvider>
        <MessageList onNavigateToAgent={onNavigateToAgent} />
      </TooltipProvider>
    </AgentContext.Provider>,
  );
}

describe('background spawn grouping (original toolCallId)', () => {
  it('groups hidden started row, live rows and the completion under the original id', () => {
    const rows = [...gp(), done('call_gp', '/root/budget_planner', 'completed', 'Drafted.')];
    const spawn = deriveBackgroundSpawns(rows).get('call_gp')!;
    expect(spawn).toMatchObject({
      agentType: 'general_purpose',
      path: '/root/budget_planner',
      goal: 'Draft a rough budget',
      state: 'completed',
      resultSummary: 'Drafted.',
      subAgentIds: ['child-1'],
    });
  });

  it('counts for_each children under <id>:<idx>', () => {
    const spawn = deriveBackgroundSpawns(forEach()).get('call_fe')!;
    expect(spawn).toMatchObject({ agentType: 'for_each', childTotal: 3 });
    expect(spawn.subAgentIds).toEqual(['fe-a', 'fe-b', 'fe-c']);
  });

  it('a woken explore task (backgroundRun 2) is running again, then completes its next run', () => {
    const finished = [
      ...explore(),
      row({
        toolCallId: 'call_ex',
        toolName: 'spawn_agent',
        toolStatus: 'FINISHED',
        excludeFromModel: true,
        agentType: 'explore',
        taskId: 't-ex',
        title: 'Find the average hotel price',
      }),
      done('call_ex', '/root/hotel_price', 'completed', 'About $210.'),
    ];
    expect(deriveBackgroundSpawns(finished).get('call_ex')!.state).toBe('completed');
    const rerun = row({
      toolCallId: 'call_ex',
      toolName: 'spawn_agent',
      toolStatus: 'IN_PROGRESS',
      excludeFromModel: true,
      agentType: 'explore',
      taskId: 't-ex-2',
      title: 'Exploring',
      backgroundRun: 2,
    });
    const woken = deriveBackgroundSpawns([...finished, rerun]).get('call_ex')!;
    expect(woken).toMatchObject({
      state: 'running',
      run: 2,
      finishedAt: null,
      resultSummary: null,
      path: '/root/hotel_price',
    });
    const second = row(
      {
        agentNotification: true,
        toolName: 'agent_notification',
        fromAgentAddress: '/root/hotel_price',
        status: 'completed',
        backgroundTaskId: 'call_ex',
        backgroundRun: 2,
      },
      'Message Type: FINAL_ANSWER\nTask name: x\nSender: /root/hotel_price\nPayload:\nAbout $230 in 2027.',
      'USER',
    );
    expect(deriveBackgroundSpawns([...finished, rerun, second]).get('call_ex')).toMatchObject({
      state: 'completed',
      run: 2,
      resultSummary: 'About $230 in 2027.',
    });
    renderDock([...finished, rerun]);
    expect(screen.getByTestId('background-agents-banner')).toHaveTextContent('Running 1 agent');
  });

  it('leaves foreground spawns (no background markers) alone', () => {
    const fg = row({
      toolCallId: 'call_fg',
      toolName: 'spawn_general_purpose_agent',
      toolStatus: 'IN_PROGRESS',
      subAgentIds: ['fg-1'],
      busId: 'root-1',
    });
    expect(deriveBackgroundSpawns([fg]).size).toBe(0);
  });
});

describe('trajectory: main spawn UI for background rows', () => {
  it('renders a GP background spawn with main SubAgentTree, without the hidden started row', () => {
    tree.nodes.set(
      'child-1',
      makeAgentTreeNode({
        agentId: 'child-1',
        parentAgentId: 'root-1',
        goal: 'Draft a rough budget',
      }),
    );
    renderList(gp());
    expect(screen.getByText('Delegating Sub Agents')).toBeInTheDocument();
    expect(screen.getByText('Draft a rough budget')).toBeInTheDocument();
    expect(screen.queryByText('Started')).not.toBeInTheDocument();
    expect(screen.queryByTestId('background-agent-chip')).not.toBeInTheDocument();
  });

  it('keeps live background rows after the parent thinks again (not reaped as orphaned)', () => {
    tree.nodes.set(
      'child-1',
      makeAgentTreeNode({
        agentId: 'child-1',
        parentAgentId: 'root-1',
        goal: 'Draft a rough budget',
      }),
    );
    renderList([...gp(), row({}, 'While that runs, I will draft the email.', 'ASSISTANT')]);
    expect(screen.getByText('Draft a rough budget')).toBeInTheDocument();
  });

  it('renders a for_each background spawn as one SubAgentTree and navigates into a child', async () => {
    const onNavigate = vi.fn();
    for (const id of ['fe-a', 'fe-b', 'fe-c']) {
      tree.nodes.set(
        id,
        makeAgentTreeNode({ agentId: id, parentAgentId: 'root-1', goal: `Venue ${id}` }),
      );
    }
    renderList(forEach(), onNavigate);
    expect(screen.getAllByText('Delegating Sub Agents')).toHaveLength(1);
    await userEvent.click(screen.getByText('Venue fe-b'));
    expect(onNavigate).toHaveBeenCalledWith('fe-b');
  });

  it('does not render child completion rows (the spawn UI shows the final state)', () => {
    renderList([...gp(), done('call_gp', '/root/budget_planner', 'failed', 'Login wall.')]);
    expect(screen.queryByText(/finished/)).not.toBeInTheDocument();
    expect(screen.queryByText('Login wall.')).not.toBeInTheDocument();
  });
});

function renderDock(messages: Message[], onNavigate = vi.fn()) {
  return render(
    <BackgroundAgentsBanner selectedAgentId="root-1" messages={messages} onNavigate={onNavigate} />,
  );
}

describe('running-agents dock', () => {
  it('is hidden when nothing is running', () => {
    renderDock([]);
    expect(screen.queryByTestId('background-agents-banner')).not.toBeInTheDocument();
  });

  it('counts running descendants + running tasks and attaches to the query box', () => {
    tree.nodes.set('child-1', makeAgentTreeNode({ agentId: 'child-1', parentAgentId: 'root-1' }));
    tree.nodes.set('g-1', makeAgentTreeNode({ agentId: 'g-1', parentAgentId: 'child-1' }));
    renderDock([...gp(), ...explore()]);
    const dock = screen.getByTestId('background-agents-banner');
    expect(dock).toHaveTextContent('Running 3 agents');
    expect(dock).toHaveAttribute('data-query-input-attachment');
  });

  it('expands to the SubAgentTree hierarchy, navigates on agents, collapses on Escape', async () => {
    const onNavigate = vi.fn();
    tree.nodes.set(
      'child-1',
      makeAgentTreeNode({ agentId: 'child-1', parentAgentId: 'root-1', goal: 'Draft budget' }),
    );
    renderDock([...gp(), ...explore()], onNavigate);
    await userEvent.click(screen.getByRole('button', { name: /Running 2 agents/ }));
    const panel = screen.getByTestId('background-agents-panel');
    expect(panel.textContent).toContain('└─');
    expect(panel).toHaveTextContent('explore · hotel_price');
    await userEvent.click(within(panel).getByText('Draft budget'));
    expect(onNavigate).toHaveBeenCalledWith('child-1');
    onNavigate.mockClear();
    await userEvent.click(within(panel).getByText('explore · hotel_price'));
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByTestId('background-agents-panel')).not.toBeInTheDocument();
  });

  it('groups for_each children under one cluster header', async () => {
    for (const id of ['fe-a', 'fe-b', 'fe-c']) {
      tree.nodes.set(id, makeAgentTreeNode({ agentId: id, parentAgentId: 'root-1' }));
    }
    renderDock(forEach());
    await userEvent.click(screen.getByRole('button', { name: /Running 3 agents/ }));
    const groups = screen.getAllByTestId('agent-panel-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveTextContent('for_each · venue_capacities');
  });

  it('shows a collapsed per-agent output schema that expands to fields and results', async () => {
    tree.nodes.set(
      'child-1',
      makeAgentTreeNode({
        agentId: 'child-1',
        parentAgentId: 'root-1',
        goal: 'Draft budget',
        status: 'COMPLETED',
        outputSchema: {
          fields: [
            { name: 'total_budget_usd', type: 'float', required: true, description: '' },
            { name: 'notes', type: 'str', required: false, description: '' },
          ],
        },
        structuredOutput: { total_budget_usd: 5518, notes: 'Two nights' },
      }),
    );
    renderDock([...gp(), ...explore()]);
    await userEvent.click(screen.getByRole('button', { name: /Running 1 agent/ }));
    const toggle = screen.getByTestId('dock-schema-toggle');
    expect(toggle).toHaveTextContent('output schema · 2 fields · result');
    expect(screen.queryByText('5518')).not.toBeInTheDocument();
    await userEvent.click(toggle);
    const schema = screen.getByTestId('dock-node-schema');
    expect(schema).toHaveTextContent('total budget usd');
    expect(schema).toHaveTextContent('required');
    expect(schema).toHaveTextContent('optional');
    expect(schema).toHaveTextContent('5518');
  });

  it('shows one results table per for_each cluster', async () => {
    const schema = {
      fields: [
        { name: 'venue_name', type: 'str', required: true, description: '' },
        { name: 'capacity', type: 'int', required: true, description: '' },
      ],
    };
    tree.nodes.set(
      'fe-a',
      makeAgentTreeNode({
        agentId: 'fe-a',
        parentAgentId: 'root-1',
        status: 'COMPLETED',
        outputSchema: schema,
        structuredOutput: { venue_name: 'Fair Market', capacity: 900 },
      }),
    );
    tree.nodes.set(
      'fe-b',
      makeAgentTreeNode({ agentId: 'fe-b', parentAgentId: 'root-1', outputSchema: schema }),
    );
    tree.nodes.set(
      'fe-c',
      makeAgentTreeNode({ agentId: 'fe-c', parentAgentId: 'root-1', outputSchema: schema }),
    );
    renderDock(forEach());
    await userEvent.click(screen.getByRole('button', { name: /Running 2 agents/ }));
    expect(screen.getAllByTestId('dock-schema-toggle')).toHaveLength(1);
    await userEvent.click(screen.getByTestId('dock-schema-toggle'));
    const table = screen.getByTestId('dock-results-table');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(table).toHaveTextContent('Fair Market');
    expect(table).toHaveTextContent('string · required');
  });
});
