import { describe, expect, it } from 'vitest';
import { handleInsertMessage } from '@/features/agent-context/hooks/realtimeMessageInsert';
import { mkSetters } from './realtime-handlers.fixtures';

describe('durable browser pause refresh', () => {
  it('updates the same result in place, retaining error and order; replay cannot undo it', () => {
    const setters = mkSetters();
    const original = {
      agentId: 'agent',
      id: 'result',
      timestamp: '2026-01-01T00:00:00Z',
      role: 'TOOL' as const,
      text: 'Original error',
      metadata: {
        toolCallId: 'call',
        toolName: 'spawn_browser_agent',
        toolStatus: 'ERROR' as const,
        error: true,
        workflowGeneration: 'generation',
      },
    };
    handleInsertMessage(original, 'agent', setters);
    handleInsertMessage(
      {
        ...original,
        id: 'next',
        timestamp: '2026-01-01T00:00:01Z',
        role: 'ASSISTANT',
        text: 'Next turn',
        metadata: {},
      },
      'agent',
      setters,
    );
    const paused = {
      ...original,
      text: 'Original error\n\n[User paused the browser agent.]',
      metadata: {
        ...original.metadata,
        userPause: {
          reason: 'user' as const,
          recordedAt: '2026-01-01T00:00:02Z',
        },
      },
    };
    handleInsertMessage(paused, 'agent', setters);
    handleInsertMessage(paused, 'agent', setters);
    handleInsertMessage(original, 'agent', setters);
    expect(setters.state.messages.map((m) => m.message_id)).toEqual(['result', 'next']);
    expect(setters.state.messages[0].text).toBe(paused.text);
    expect(setters.state.messages[0].metadata?.error).toBe(true);
    expect(setters.state.messages[0].timestamp).toBe(original.timestamp);
  });
});
