/**
 * Blackbox: the one-line running work row shows a spawned agent's current tool
 * as a smaller rotating line beneath it, like the explore chip and the
 * sub-agent tree do (Andy 2026-10-28).
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentContext } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { TrajectoryWorkGroup } from '@/features/terminal-component-group/components/TrajectoryWorkGroup';
import { groupTrajectoryWork } from '@/features/terminal-component-group/components/trajectoryWorkGroups';
import type { Message } from '@/features/terminal-component-group/hooks';
import { makeCtx } from './browser-agent-chip.fixtures';
import { msg } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';

const tree = vi.hoisted(() => ({ nodes: new Map<string, unknown>() }));
vi.mock('@/hooks/useAgentTree', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useAgentTree');
  return { ...actual, useAgentTree: (busId: string | null) => (busId ? tree.nodes : new Map()) };
});
vi.mock('@/components/ThinkingAnimation', () => ({ default: () => null }));
// The carousel's exit animation is frame-driven; render each item swap directly.
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('framer-motion');
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const start = Date.UTC(2026, 9, 28, 12);
const at = (offset: number) => new Date(start + offset).toISOString();

function exploreRow(
  id: string,
  metadata: Record<string, unknown>,
  offset: number,
  toolStatus = 'IN_PROGRESS',
): Message {
  return msg(
    { agentType: 'explore', taskId: 'task-1', toolStatus, ...metadata },
    { message_id: id, timestamp: at(offset) },
  );
}

function renderList(messages: Message[]) {
  const ctx = {
    ...makeCtx(messages),
    agent: { id: 'agent-1', status: 'ACTIVE', updated_at: messages.at(-1)!.timestamp } as never,
  };
  return renderWithProviders(
    <AgentContext.Provider value={ctx}>
      <MessageList showThinkingIndicator={false} />
    </AgentContext.Provider>,
  );
}

function node(agentId: string, status: string, toolsInUse: string[]) {
  return {
    agentId,
    parentAgentId: 'root-1',
    goal: agentId,
    status,
    progress: 0,
    toolsInUse,
    messageCount: 1,
    costCents: 0,
  };
}

function gpGroup(status = 'ACTIVE') {
  const spawn = msg(
    {
      toolName: 'spawn_general_purpose_agent_for_each',
      toolCallId: 'gp-call',
      toolStatus: 'IN_PROGRESS',
      title: 'Researching 3 vendors',
      busId: 'root-1',
      subAgentIds: ['child-a', 'child-b', 'child-c'],
    },
    { message_id: 'gp-spawn', timestamp: at(0) },
  );
  return [...groupTrajectoryWork([spawn], status, at(5000)).groupsByLeadId.values()][0];
}

beforeEach(() => {
  tree.nodes = new Map();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('running work row: spawned agent tool line', () => {
  it("rotates through a running explore agent's in-progress tools beneath the row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 3000);
    renderList([
      exploreRow('spawn', { toolName: 'spawn_agent', toolCallId: 'x', title: 'Exploring' }, 0),
      exploreRow(
        'search',
        { toolName: 'web_search', toolCallId: 's', title: 'Searching the web for espresso' },
        1000,
      ),
      exploreRow('grep', { toolName: 'grep', toolCallId: 'g', title: 'Grep: espresso' }, 1100),
    ]);
    const group = screen.getByTestId('trajectory-work-group');
    expect(group).toHaveAttribute('data-state', 'running');
    const line = within(group).getByTestId('spawned-agent-tool-line');
    expect(line).toHaveTextContent('Searching the web for espresso');
    expect(within(line).getByTestId('explore-active-tool-icon')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(within(group).getByTestId('spawned-agent-tool-line')).toHaveTextContent(
      'Grep: espresso',
    );
    // Expanding shows the history instead; the summary line steps aside.
    fireEvent.click(within(group).getByRole('button', { expanded: false }));
    expect(within(group).queryByTestId('spawned-agent-tool-line')).toBeNull();
  });

  it("shows only running general-purpose children's tools, and nothing once the batch is done", () => {
    tree.nodes = new Map([
      ['child-a', node('child-a', 'ACTIVE', ['Searching the web for vendors'])],
      ['child-b', node('child-b', 'COMPLETED', ['Reading messages'])],
      ['child-c', node('child-c', 'ACTIVE', ['Searching the web for vendors'])],
    ]);
    const view = render(<TrajectoryWorkGroup group={gpGroup()} renderMessage={() => null} />);
    const line = screen.getByTestId('spawned-agent-tool-line');
    expect(line).toHaveTextContent('Searching the web for vendors');
    expect(line).not.toHaveTextContent('Reading messages');
    view.rerender(<TrajectoryWorkGroup group={gpGroup('COMPLETED')} renderMessage={() => null} />);
    expect(screen.queryByTestId('spawned-agent-tool-line')).toBeNull();
  });

  it('renders no line for an ordinary tool or an idle spawned agent', () => {
    tree.nodes = new Map([['child-a', node('child-a', 'ACTIVE', [])]]);
    render(<TrajectoryWorkGroup group={gpGroup()} renderMessage={() => null} />);
    expect(screen.queryByTestId('spawned-agent-tool-line')).toBeNull();
    cleanup();
    const read = msg(
      { toolName: 'read_file', toolCallId: 'r', toolStatus: 'IN_PROGRESS', title: 'read_file' },
      { message_id: 'read', timestamp: at(0) },
    );
    const group = [...groupTrajectoryWork([read], 'ACTIVE').groupsByLeadId.values()][0];
    render(<TrajectoryWorkGroup group={group} renderMessage={() => null} />);
    expect(screen.queryByTestId('spawned-agent-tool-line')).toBeNull();
  });
});
