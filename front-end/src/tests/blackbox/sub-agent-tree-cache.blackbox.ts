import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Message } from '@/lib/api';
import { useSubAgentTreeMerge } from '@/features/terminal-component-group/components/useSubAgentTreeMerge';

it('refreshes merged sub-agent text when the same spawn group receives an updated message', () => {
  const message: Message = {
    message_id: 'spawn-update',
    timestamp: '2026-10-14T17:33:50Z',
    role: 'TOOL',
    text: 'First result',
    metadata: {
      toolName: 'spawn_general_purpose_agent',
      toolCallId: 'spawn',
      toolStatus: 'FINISHED',
      subAgentIds: ['child'],
      busId: 'root',
    },
  };
  const { result, rerender } = renderHook(
    ({ messages }) => useSubAgentTreeMerge(messages, 'root'),
    {
      initialProps: { messages: [message] },
    },
  );
  expect(result.current[0].text).toBe('First result');
  rerender({ messages: [{ ...message, text: 'Updated result' }] });
  expect(result.current[0].text).toBe('Updated result');
});
