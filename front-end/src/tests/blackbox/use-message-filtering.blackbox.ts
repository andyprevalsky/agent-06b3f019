import { describe, expect, it } from 'vitest';
import { mergeSubAgentTreeMessages } from '@/features/terminal-component-group/components/useMessageFiltering';
import type { Message } from '@/lib/api';

function msg(id: string, metadata: Record<string, unknown>, text = ''): Message {
  return {
    message_id: id,
    timestamp: new Date().toISOString(),
    role: 'TOOL',
    text,
    metadata,
  };
}

describe('useMessageFiltering mergeSubAgentTreeMessages', () => {
  it('turns a terminal for_each response into one aggregate tree message', () => {
    const messages = [
      msg('for-each-start', {
        toolCallId: 'call-1',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'IN_PROGRESS',
        title: 'Spawning agent cluster',
      }),
      msg('child-a', {
        toolCallId: 'call-1:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        title: 'Spawning sub-agent',
        busId: 'root-bus',
        subAgentIds: ['agent-a'],
      }),
      msg('child-b', {
        toolCallId: 'call-1:1',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'ERROR',
        title: 'Sub-agent failed',
        busId: 'root-bus',
        subAgentIds: ['agent-b'],
      }),
      msg(
        'for-each-failed',
        {
          toolCallId: 'call-1',
          toolName: 'spawn_general_purpose_agent_for_each',
          toolStatus: 'ERROR',
          title: 'for_each failed',
        },
        '1/2 children failed\n\nChild outputs:\n- item 1: failed',
      ),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);
    const aggregate = result.find((message) => message.message_id === 'for-each-failed');

    // The IN_PROGRESS "Spawning..." placeholder folds away once children exist;
    // only the merged aggregate tree remains.
    expect(result.map((message) => message.message_id)).toEqual(['for-each-failed']);
    expect(aggregate?.metadata?.forEachAggregate).toBe(true);
    expect(aggregate?.metadata?.busId).toBe('root-bus');
    expect(aggregate?.metadata?.subAgentIds).toEqual(['agent-a', 'agent-b']);
  });

  it('folds the for_each placeholder into the child tree mid-run (no terminal yet)', () => {
    const messages = [
      msg('for-each-start', {
        toolCallId: 'call-1',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'IN_PROGRESS',
        title: 'Spawning agent cluster',
      }),
      msg('child-a', {
        toolCallId: 'call-1:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        busId: 'root-bus',
        subAgentIds: ['agent-a'],
      }),
      msg('child-b', {
        toolCallId: 'call-1:1',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        busId: 'root-bus',
        subAgentIds: ['agent-b'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    // No stray "Spawning..." placeholder — just the single grouped child tree.
    expect(result).toHaveLength(1);
    expect(result[0].metadata?.toolName).toBe('spawn_general_purpose_agent');
    expect(result[0].metadata?.subAgentIds).toEqual(['agent-a', 'agent-b']);
  });

  it('folds the for_each placeholder when child tree is grouped by spawnGroupId', () => {
    const messages = [
      msg('for-each-start', {
        toolCallId: 'call-1',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'IN_PROGRESS',
        title: 'Spawning agent cluster',
      }),
      msg('child-tree', {
        toolCallId: 'child-tree-call',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        busId: 'root-bus',
        spawnGroupId: 'call-1',
        subAgentIds: ['agent-a', 'agent-b'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].message_id).toBe('child-tree');
    expect(result[0].metadata?.subAgentIds).toEqual(['agent-a', 'agent-b']);
  });

  it('keeps the for_each placeholder visible before any child has spawned', () => {
    const messages = [
      msg('for-each-start', {
        toolCallId: 'call-1',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'IN_PROGRESS',
        title: 'Spawning agent cluster',
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    expect(result.map((message) => message.message_id)).toEqual(['for-each-start']);
  });

  it('keeps legacy child spawn summaries with different base calls separate under the same bus', () => {
    const messages = [
      msg('a-child', {
        toolCallId: 'call-a:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        subAgentIds: ['agent-a'],
      }),
      msg('b-child', {
        toolCallId: 'call-b:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        subAgentIds: ['agent-b'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].metadata?.subAgentIds).toEqual(['agent-a']);
    expect(result[1].metadata?.subAgentIds).toEqual(['agent-b']);
  });

  it('keeps distinct spawnGroupId clusters separate under the same bus', () => {
    const messages = [
      msg('a-child', {
        toolCallId: 'call-a',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        spawnGroupId: 'call-a',
        subAgentIds: ['agent-a'],
      }),
      msg('b-child', {
        toolCallId: 'call-b',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        spawnGroupId: 'call-b',
        subAgentIds: ['agent-b'],
      }),
      msg('b-child-retry', {
        toolCallId: 'call-b:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        spawnGroupId: 'call-b',
        subAgentIds: ['agent-b-retry'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].metadata?.subAgentIds).toEqual(['agent-a']);
    expect(result[1].metadata?.subAgentIds).toEqual(['agent-b', 'agent-b-retry']);
  });

  it('merges same-turn spawn summaries by spawnGroupId', () => {
    const messages = [
      msg('a-child', {
        toolCallId: 'call-a',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        spawnGroupId: 'llm-turn:execute:2',
        subAgentIds: ['agent-a'],
      }),
      msg('b-child', {
        toolCallId: 'call-b',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        spawnGroupId: 'llm-turn:execute:2',
        subAgentIds: ['agent-b'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].metadata?.subAgentIds).toEqual(['agent-a', 'agent-b']);
  });

  it('keeps a backend-emitted for_each aggregate from absorbing later DAG clusters', () => {
    const messages = [
      msg('for-each-complete', {
        toolCallId: 'foreach-1',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'FINISHED',
        title: 'for_each complete',
        busId: 'root-bus',
        spawnGroupId: 'dag-task:2',
        subAgentIds: ['agent-a', 'agent-b'],
      }),
      msg('later-child', {
        toolCallId: 'later-1',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        spawnGroupId: 'dag-task:3',
        subAgentIds: ['agent-c'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].metadata?.forEachAggregate).toBe(true);
    expect(result[0].metadata?.subAgentIds).toEqual(['agent-a', 'agent-b']);
    expect(result[1].metadata?.subAgentIds).toEqual(['agent-c']);
  });

  it('synthesizes a root-visible tree for legacy single-spawn child progress', () => {
    const messages = [
      msg('child-start', {
        toolCallId: 'single-call',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        subAgentId: 'child-a',
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages, new Map(), 'root-agent');

    expect(result).toHaveLength(1);
    expect(result[0].metadata?.busId).toBe('root-agent');
    expect(result[0].metadata?.spawnGroupId).toBe('single-call');
    expect(result[0].metadata?.subAgentIds).toEqual(['child-a']);
  });

  it('synthesizes legacy for_each child progress into the for_each group', () => {
    const messages = [
      msg('child-a-start', {
        toolCallId: 'for-each-call:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        subAgentId: 'child-a',
      }),
      msg('child-b-start', {
        toolCallId: 'for-each-call:1',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        subAgentId: 'child-b',
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages, new Map(), 'root-agent');

    expect(result).toHaveLength(1);
    expect(result[0].metadata?.spawnGroupId).toBe('for-each-call');
    expect(result[0].metadata?.subAgentIds).toEqual(['child-a', 'child-b']);
  });

  it('keeps completed for_each children in the same live tree when backend uses raw base spawnGroupId', () => {
    const messages = [
      msg('child-a-start', {
        toolCallId: 'for-each-call:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        subAgentId: 'child-a',
      }),
      msg('child-a-complete', {
        toolCallId: 'for-each-call:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        title: 'Sub-agent completed',
        busId: 'root-agent',
        spawnGroupId: 'for-each-call',
        subAgentIds: ['child-a'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages, new Map(), 'root-agent');

    expect(result).toHaveLength(1);
    expect(result[0].metadata?.subAgentIds).toEqual(['child-a']);
  });

  it('replaces legacy for_each child-progress tree with terminal aggregate instead of rendering both', () => {
    const messages = [
      msg('child-a-start', {
        toolCallId: 'for-each-call:0',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        subAgentId: 'child-a',
      }),
      msg('child-b-start', {
        toolCallId: 'for-each-call:1',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
        title: 'Sub-agent starting',
        subAgentId: 'child-b',
      }),
      msg('for-each-terminal', {
        toolCallId: 'for-each-call',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'FINISHED',
        busId: 'root-agent',
        subAgentIds: ['child-a', 'child-b'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages, new Map(), 'root-agent');

    expect(result).toHaveLength(1);
    expect(result[0].message_id).toBe('for-each-terminal');
    expect(result[0].metadata?.subAgentIds).toEqual(['child-a', 'child-b']);
  });

  it('does not merge legacy for_each aggregate and legacy single-spawn trees just because busId matches', () => {
    const messages = [
      msg('for-each-terminal', {
        toolCallId: 'for-each-call',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        subAgentIds: ['for-each-child'],
      }),
      msg('single-terminal', {
        toolCallId: 'single-call',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        busId: 'root-bus',
        subAgentIds: ['single-child'],
      }),
    ];

    const { result } = mergeSubAgentTreeMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].metadata?.subAgentIds).toEqual(['for-each-child']);
    expect(result[1].metadata?.subAgentIds).toEqual(['single-child']);
  });
});
