/** Replayed stale frames and paused streams must release work without changing content. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  handleAssistantStream,
  handleToolStream,
} from '@/features/agent-context/hooks/realtimeHandlers';
import { useAgentProviderState } from '@/features/agent-context/hooks/useAgentProviderState';
import { useAgentProviderEffects } from '@/features/agent-context/hooks/useAgentProviderEffects';
import type { StreamingBubble, StreamingTool } from '@/features/agent-context/types';
import type { AgentDetail } from '@/lib/api';
import { mkSetters } from './realtime-handlers.fixtures';
import { agentDetailJson } from './realtime-subscription.fixtures';

vi.mock('@/features/agent-context/hooks/useRealtimeSubscription', () => ({
  useRealtimeSubscription: vi.fn(),
}));
vi.mock('@/features/agent-context/hooks/useVisibilityReconnect', () => ({
  useVisibilityReconnect: vi.fn(),
}));
vi.mock('@/features/agent-context/hooks/useHealthCheck', () => ({ useHealthCheck: vi.fn() }));
vi.mock('@/features/agent-context/hooks/usePopstateSync', () => ({ usePopstateSync: vi.fn() }));

afterEach(() => vi.useRealTimers());

function observeCopies<T>(values: Map<string, T>) {
  let entriesRead = 0;
  const entries = values.entries.bind(values);
  Object.defineProperty(values, Symbol.iterator, {
    value: function* () {
      for (const entry of entries()) {
        entriesRead += 1;
        yield entry;
      }
    },
  });
  return () => entriesRead;
}

it('ignores 100 stale assistant frames without copying 10,000 concurrent streams', () => {
  const state = mkSetters();
  state.state.streamingBubbles = new Map<string, StreamingBubble>(
    Array.from({ length: 10_000 }, (_, i) => [
      `stream-${i}`,
      { text: `Current ${i}`, sequence: 20, done: false },
    ]),
  );
  const original = state.state.streamingBubbles;
  const copies = observeCopies(original);
  for (let i = 0; i < 100; i++) {
    handleAssistantStream(
      { agentId: 'agent-1', stream_id: 'stream-9999', sequence: 19, delta: 'stale', done: false },
      'agent-1',
      { current: new Set() },
      state.setStreamingBubbles,
    );
  }
  expect(state.state.streamingBubbles.get('stream-9999')?.text).toBe('Current 9999');
  expect(state.state.streamingBubbles).toBe(original);
  expect(copies()).toBe(0);
});

it('ignores completed absent tools without copying 10,000 active tools', () => {
  const state = mkSetters();
  state.state.streamingTools = new Map<string, StreamingTool>(
    Array.from({ length: 10_000 }, (_, i) => [
      `task-${i}`,
      {
        stream_id: `stream-${i}`,
        tool_call_id: `task-${i}`,
        tool_name: 'read_file',
        title: `Read ${i}`,
      },
    ]),
  );
  const original = state.state.streamingTools;
  const copies = observeCopies(original);
  for (let i = 0; i < 100; i++) {
    handleToolStream(
      {
        agentId: 'agent-1',
        stream_id: 'retired',
        tool_call_id: 'retired',
        tool_name: 'read_file',
        title: 'Finished',
        status: 'FINISHED',
      },
      'agent-1',
      state.setStreamingTools,
    );
  }
  expect(state.state.streamingTools.size).toBe(10_000);
  expect(state.state.streamingTools).toBe(original);
  expect(copies()).toBe(0);
});

it('pausing releases every completed-stream expiry timer immediately', () => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() => {
    const state = useAgentProviderState();
    useAgentProviderEffects(state, {
      canSubscribe: false,
      dispatchMessage: vi.fn(),
      setSelectedAgentId: vi.fn(),
    });
    return state;
  });
  try {
    const agent = agentDetailJson([]).agent as AgentDetail;
    act(() => result.current.setAgent(agent));
    act(() => {
      for (let i = 0; i < 1_000; i++) {
        handleAssistantStream(
          {
            agentId: 'agent-1',
            stream_id: `done-${i}`,
            sequence: 1,
            delta: `Final ${i}`,
            done: true,
          },
          'agent-1',
          result.current.streamedTextsRef,
          result.current.setStreamingBubbles,
        );
      }
    });
    expect(result.current.streamingBubbles.size).toBe(1_000);
    expect(vi.getTimerCount()).toBe(1_000);
    act(() => result.current.setAgent({ ...agent, status: 'PAUSED' }));
    expect(result.current.streamingBubbles.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    unmount();
  }
});
