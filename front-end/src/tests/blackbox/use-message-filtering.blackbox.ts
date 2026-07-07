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

  it('merges separate spawn summaries under the same bus into one tree', () => {
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

    expect(result).toHaveLength(1);
    expect(result[0].metadata?.subAgentIds).toEqual(['agent-a', 'agent-b']);
  });
});
