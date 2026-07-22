/**
 * Browser expanded-view realtime lifecycle.
 *
 * STREAMING -> terminal event -> CLEARED
 * PERSISTED INSERT may interleave anywhere; the terminal event is authoritative.
 * Each persisted assistant references its exact stream so an older insert cannot
 * erase the next browser iteration.
 */
import type { SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDetail, Message } from '@/lib/api';
import type { InsertMessagePayload } from '@/lib/realtime';
import type {
  StreamingAttention,
  StreamingBubble,
  StreamingPlan,
  StreamingTool,
} from '@/features/agent-context/types';
import {
  handleAssistantStream,
  handleInsertMessage,
  handleToolStream,
  type RealtimeSetters,
} from '@/features/agent-context/hooks/realtimeHandlers';
import { coalesceStreamingTools } from '@/features/terminal-component-group/components/useMessageFiltering';

function reduceState<T>(current: T, action: SetStateAction<T>): T {
  return typeof action === 'function' ? (action as (previous: T) => T)(current) : action;
}

function makeHarness() {
  const state: {
    bubbles: Map<string, StreamingBubble>;
    plan: StreamingPlan | null;
    attention: StreamingAttention | null;
    tools: Map<string, StreamingTool>;
    messages: Message[];
    agent: AgentDetail | null;
    isChatMode: boolean;
  } = {
    bubbles: new Map(),
    plan: null,
    attention: null,
    tools: new Map(),
    messages: [],
    agent: null,
    isChatMode: false,
  };
  const setters: RealtimeSetters = {
    setStreamingBubbles: (action) => {
      state.bubbles = reduceState(state.bubbles, action);
    },
    setStreamingPlan: (action) => {
      state.plan = reduceState(state.plan, action);
    },
    setStreamingAttention: (action) => {
      state.attention = reduceState(state.attention, action);
    },
    setStreamingTools: (action) => {
      state.tools = reduceState(state.tools, action);
    },
    setMessages: (action) => {
      state.messages = reduceState(state.messages, action);
    },
    setAgent: (action) => {
      state.agent = reduceState(state.agent, action);
    },
    setIsChatMode: (action) => {
      state.isChatMode = reduceState(state.isChatMode, action);
    },
    dispatchMessage: vi.fn(),
  };
  return { state, setters };
}

describe('browser realtime stream lifecycle', () => {
  it('removes sequential tool-only thinking streams immediately on done', () => {
    const { state, setters } = makeHarness();
    const streamedTextsRef = { current: new Set<string>() };
    const completedStreamIdsRef = { current: new Set<string>() };

    for (const streamId of ['browser-1', 'browser-2']) {
      handleAssistantStream(
        {
          agentId: 'agent',
          stream_id: streamId,
          sequence: 0,
          delta: '',
          done: false,
          subAgentId: 'browser-task',
          clear_on_done: true,
        },
        'agent',
        streamedTextsRef,
        setters.setStreamingBubbles,
        completedStreamIdsRef,
      );
      expect(state.bubbles.has(streamId)).toBe(true);

      handleAssistantStream(
        {
          agentId: 'agent',
          stream_id: streamId,
          sequence: 1,
          delta: '',
          done: true,
          subAgentId: 'browser-task',
          clear_on_done: true,
        },
        'agent',
        streamedTextsRef,
        setters.setStreamingBubbles,
        completedStreamIdsRef,
      );
      expect(state.bubbles.size).toBe(0);
    }
  });

  it('does not resurrect a cleared stream when an earlier delta arrives late', () => {
    const { state, setters } = makeHarness();
    const streamedTextsRef = { current: new Set<string>() };
    const completedStreamIdsRef = { current: new Set<string>() };
    const base = {
      agentId: 'agent',
      stream_id: 'browser-completed',
      subAgentId: 'browser-task',
      clear_on_done: true,
    };

    handleAssistantStream(
      { ...base, sequence: 2, delta: '', done: true },
      'agent',
      streamedTextsRef,
      setters.setStreamingBubbles,
      completedStreamIdsRef,
    );
    handleAssistantStream(
      { ...base, sequence: 1, delta: 'late', done: false },
      'agent',
      streamedTextsRef,
      setters.setStreamingBubbles,
      completedStreamIdsRef,
    );

    expect(state.bubbles.size).toBe(0);
  });

  it('keeps the current iteration when a prior assistant INSERT arrives late', () => {
    const { state, setters } = makeHarness();
    state.bubbles.set('browser-current', {
      text: 'new iteration',
      sequence: 1,
      done: false,
      subAgentId: 'browser-task',
    });
    const priorInsert: InsertMessagePayload = {
      agentId: 'agent',
      id: 'prior-assistant',
      timestamp: '2026-07-11T00:00:00Z',
      text: 'prior iteration',
      role: 'ASSISTANT',
      metadata: { subAgentId: 'browser-task', streamId: 'browser-prior' },
    };

    handleInsertMessage(priorInsert, 'agent', setters);

    expect(state.bubbles.has('browser-current')).toBe(true);
  });

  it('does not render a tool start delivered after its persisted INSERT', () => {
    const { state, setters } = makeHarness();
    const persistedTool: InsertMessagePayload = {
      agentId: 'agent',
      id: 'persisted-tool',
      timestamp: '2026-07-11T00:00:00Z',
      text: '',
      role: 'TOOL',
      metadata: {
        subAgentId: 'browser-task',
        toolCallId: 'browser-call',
        toolName: 'rotate_ip',
        toolStatus: 'IN_PROGRESS',
      },
    };
    handleInsertMessage(persistedTool, 'agent', setters);

    handleToolStream(
      {
        agentId: 'agent',
        stream_id: 'browser-stream',
        tool_call_id: 'browser-call',
        tool_name: 'rotate_ip',
        title: 'Starting rotate_ip...',
        subAgentId: 'browser-task',
      },
      'agent',
      setters.setStreamingTools,
    );
    expect(state.tools.has('browser-call')).toBe(true);
    expect(coalesceStreamingTools(state.tools, state.messages, 'browser-task').size).toBe(0);

    handleToolStream(
      {
        agentId: 'agent',
        stream_id: 'browser-stream',
        tool_call_id: 'browser-call',
        tool_name: 'rotate_ip',
        title: 'Finished rotate_ip',
        status: 'FINISHED',
        subAgentId: 'browser-task',
      },
      'agent',
      setters.setStreamingTools,
    );
    expect(state.tools.has('browser-call')).toBe(false);
  });
});
