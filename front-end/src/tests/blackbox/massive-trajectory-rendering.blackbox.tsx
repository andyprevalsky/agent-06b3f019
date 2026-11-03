import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFilteredMessages } from '@/features/terminal-component-group/components/useMessageFiltering';
import { useSubAgentTreeData } from '@/features/terminal-component-group/components/subAgentTree/useSubAgentTreeData';
import type { Message } from '@/features/terminal-component-group/hooks';
import type { TreeNode } from '@/hooks/useAgentTree';

const tree = vi.hoisted(() => ({ nodes: new Map<string, TreeNode>() }));
vi.mock('@/hooks/useAgentTree', async (original) => ({
  ...(await original<typeof import('@/hooks/useAgentTree')>()),
  useAgentTree: () => tree.nodes,
}));

function row(
  index: number,
  metadata: Record<string, unknown>,
  role: Message['role'] = 'TOOL',
): Message {
  return {
    message_id: `row-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    text: role === 'ASSISTANT' ? `Historical answer ${index}` : `Result ${index}`,
    role,
    metadata,
  };
}

function node(index: number, parentAgentId: string | null): TreeNode {
  return {
    agentId: `agent-${index}`,
    parentAgentId,
    goal: `Agent ${index}`,
    status: 'COMPLETED',
    progress: 1,
    toolsInUse: [],
    messageCount: 1,
    costCents: 0,
  };
}

describe('massive trajectory data changes', () => {
  it('keeps unchanged historical rows stable when one of 100k tools updates', () => {
    const history = Array.from({ length: 100_000 }, (_, index) =>
      row(index, {
        toolCallId: `call-${index}`,
        toolName: 'read_file',
        toolStatus: 'FINISHED',
      }),
    );
    const { result, rerender, unmount } = renderHook(
      ({ messages }) => useFilteredMessages(messages, undefined),
      { initialProps: { messages: history } },
    );
    const unchanged = result.current.filteredMessagesRaw[50_000];
    const updated = {
      ...history[0],
      text: 'Revised result',
      metadata: { ...history[0].metadata, title: 'Revised' },
    };
    rerender({ messages: [updated, ...history.slice(1)] });
    expect(result.current.filteredMessagesRaw).toHaveLength(history.length);
    expect(result.current.filteredMessagesRaw[0].text).toBe('Revised result');
    expect(result.current.filteredMessagesRaw[50_000]).toBe(unchanged);
    unmount();
  });

  it('inserts a wait check into 100k heterogeneous rows without searching history per wait call', () => {
    let identityReads = 0;
    const calls = 5_000;
    const history: Message[] = Array.from({ length: 100_000 }, (_, index) => {
      const waiting = index < calls * 2;
      const id = waiting ? `wait-${Math.floor(index / 2)}` : `call-${index}`;
      const metadata = {
        get toolCallId() {
          identityReads++;
          return id;
        },
        toolName: waiting ? 'wait_for' : 'read_file',
        toolStatus: 'FINISHED',
        ...(waiting ? { checkNum: index % 2, maxChecks: 3 } : {}),
      };
      return row(index, metadata, !waiting && index % 3 === 0 ? 'ASSISTANT' : 'TOOL');
    });
    let commits = 0;
    const { result, rerender, unmount } = renderHook(
      ({ messages }) => {
        commits++;
        return useFilteredMessages(messages, undefined);
      },
      { initialProps: { messages: history } },
    );
    identityReads = 0;
    commits = 0;
    const inserted = row(100_000, {
      toolCallId: 'wait-0',
      toolName: 'wait_for',
      toolStatus: 'FINISHED',
      checkNum: 2,
      maxChecks: 3,
    });
    rerender({ messages: [...history, inserted] });
    const reads = identityReads;
    expect(result.current.filteredMessagesRaw).toHaveLength(95_000);
    expect(result.current.waitForCheckMap.size).toBe(calls);
    expect(result.current.waitForCheckMap.get('row-0')?.map((check) => check.checkNum)).toEqual([
      0, 1, 2,
    ]);
    expect(result.current.filteredMessagesRaw.at(-1)?.message_id).toBe('row-99999');
    expect(commits).toBe(1);
    process.stdout.write(`100k inserted wait check identity reads: ${reads}\n`);
    expect(reads).toBeLessThanOrEqual(history.length * 10);
    unmount();
  });

  it('derives every leaf of a 250k-wide tree without argument-stack overflow', () => {
    const count = 250_000;
    tree.nodes = new Map(
      Array.from({ length: count + 1 }, (_, index) => {
        const value = node(index, index ? 'agent-0' : null);
        return [value.agentId, value];
      }),
    );
    const { result, unmount } = renderHook(() => useSubAgentTreeData('wide', ['agent-0']));
    expect(result.current.totalAgents).toBe(count + 1);
    expect(result.current.maxDepth).toBe(2);
    expect(result.current.leafNodes).toHaveLength(count);
    expect(result.current.leafNodes[0].agentId).toBe('agent-1');
    expect(result.current.leafNodes.at(-1)?.agentId).toBe(`agent-${count}`);
    expect(result.current.intermediaryNodes.map((value) => value.agentId)).toEqual(['agent-0']);
    unmount();
    tree.nodes = new Map();
  });

  it('derives a 10k-deep tree in preorder without recursive-stack overflow', () => {
    const count = 10_000;
    tree.nodes = new Map(
      Array.from({ length: count }, (_, index) => {
        const value = node(index, index ? `agent-${index - 1}` : null);
        return [value.agentId, value];
      }),
    );
    const { result, unmount } = renderHook(() => useSubAgentTreeData('deep', ['agent-0']));
    expect(result.current.maxDepth).toBe(count);
    expect(result.current.leafNodes.map((value) => value.agentId)).toEqual([`agent-${count - 1}`]);
    expect(result.current.intermediaryNodes).toHaveLength(count - 1);
    expect(result.current.intermediaryNodes[0].agentId).toBe('agent-0');
    expect(result.current.intermediaryNodes.at(-1)?.agentId).toBe(`agent-${count - 2}`);
    unmount();
    tree.nodes = new Map();
  });

  it('preserves mixed forest preorder and replaces pending roots when node data arrives', () => {
    const values = [
      node(0, null),
      node(1, 'agent-0'),
      node(2, 'agent-0'),
      node(3, 'agent-1'),
      node(4, null),
    ];
    tree.nodes = new Map(values.map((value) => [value.agentId, value]));
    const roots = ['agent-0', 'agent-5', 'agent-4'];
    const { result, rerender, unmount } = renderHook(() => useSubAgentTreeData('mixed', roots));
    expect(result.current.leafNodes.map((value) => value.agentId)).toEqual([
      'agent-3',
      'agent-2',
      'agent-5',
      'agent-4',
    ]);
    expect(result.current.intermediaryNodes.map((value) => value.agentId)).toEqual([
      'agent-0',
      'agent-1',
    ]);
    expect(result.current.totalAgents).toBe(6);
    expect(result.current.maxDepth).toBe(3);
    const loaded = node(5, null);
    tree.nodes = new Map([...tree.nodes, [loaded.agentId, loaded]]);
    rerender();
    expect(result.current.rootNodes[1]).toBe(loaded);
    expect(result.current.totalAgents).toBe(6);
    unmount();
    tree.nodes = new Map();
  });
});
