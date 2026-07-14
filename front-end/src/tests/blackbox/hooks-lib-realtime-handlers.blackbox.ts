import type { SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    unsubscribe: vi.fn(),
  };
});

import {
  cleanupSubscription,
  handleAssistantStream,
  handleAttentionStream,
  handleInsertMessage,
  handlePlanStream,
  handleToolStream,
  handleUpdateAgent,
  type RealtimeSetters,
} from '@/features/agent-context/hooks/realtimeHandlers';
import type {
  StreamingAttention,
  StreamingBubble,
  StreamingPlan,
  StreamingTool,
} from '@/features/agent-context/types';
import type { AgentDetail, Message } from '@/lib/api';
import { shouldShowStreamingAttention } from '@/features/terminal-component-group/components/streamingAttentionVisibility';

function fakeChannel(state: 'joined' | 'closed' | 'errored' = 'joined') {
  return {
    state,
    topic: 'test',
  } as unknown as import('@supabase/supabase-js').RealtimeChannel;
}

describe('realtimeHandlers', () => {
  function applyState<T>(current: T, action: SetStateAction<T>): T {
    return typeof action === 'function' ? (action as (previous: T) => T)(current) : action;
  }

  function mkSetters() {
    const state = {
      streamingBubbles: new Map<string, StreamingBubble>(),
      streamingPlan: null as StreamingPlan | null,
      streamingAttention: null as StreamingAttention | null,
      streamingTools: new Map<string, StreamingTool>(),
      messages: [] as Message[],
      agent: null as AgentDetail | null,
      isChatMode: false,
    };
    return {
      state,
      setStreamingBubbles: (action: SetStateAction<Map<string, StreamingBubble>>) => {
        state.streamingBubbles = applyState(state.streamingBubbles, action);
      },
      setStreamingPlan: (action: SetStateAction<StreamingPlan | null>) => {
        state.streamingPlan = applyState(state.streamingPlan, action);
      },
      setStreamingAttention: (action: SetStateAction<StreamingAttention | null>) => {
        state.streamingAttention = applyState(state.streamingAttention, action);
      },
      setStreamingTools: (action: SetStateAction<Map<string, StreamingTool>>) => {
        state.streamingTools = applyState(state.streamingTools, action);
      },
      setMessages: (action: SetStateAction<Message[]>) => {
        state.messages = applyState(state.messages, action);
      },
      setAgent: (action: SetStateAction<AgentDetail | null>) => {
        state.agent = applyState(state.agent, action);
      },
      setIsChatMode: (action: SetStateAction<boolean>) => {
        state.isChatMode = applyState(state.isChatMode, action);
      },
      dispatchMessage: vi.fn(),
    } satisfies RealtimeSetters & { state: typeof state };
  }

  it('handleInsertMessage: ignores wrong agentId', () => {
    const s = mkSetters();
    handleInsertMessage({ agentId: 'other', id: 'm' } as never, 'me', s as never);
    expect(s.state.messages).toEqual([]);
  });

  it('handleInsertMessage: appends a USER message and dispatches', () => {
    const s = mkSetters();
    handleInsertMessage(
      {
        agentId: 'me',
        id: 'm1',
        timestamp: 't',
        text: 'hi',
        role: 'USER',
        metadata: null,
      } as never,
      'me',
      s as never,
    );
    expect(s.state.messages).toHaveLength(1);
    expect(s.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('handleInsertMessage: clears streamingPlan on set_plan FINISHED and streamingTools on toolCallId', () => {
    const s = mkSetters();
    s.state.streamingPlan = { stream_id: 'x' } as never;
    s.state.streamingTools.set('tc1', { tool_name: 'foo' } as never);
    handleInsertMessage(
      {
        agentId: 'me',
        id: 'm1',
        timestamp: 't',
        text: '',
        role: 'TOOL',
        metadata: { toolName: 'set_plan', toolStatus: 'FINISHED', toolCallId: 'tc1' },
      } as never,
      'me',
      s as never,
    );
    expect(s.state.streamingPlan).toBeNull();
    expect(s.state.streamingTools.has('tc1')).toBe(false);
  });

  it('handleInsertMessage: dedup by existing message_id', () => {
    const s = mkSetters();
    s.state.messages = [{ message_id: 'dup' } as never];
    handleInsertMessage(
      { agentId: 'me', id: 'dup', timestamp: 't', text: '', role: 'USER' } as never,
      'me',
      s as never,
    );
    expect(s.state.messages).toHaveLength(1);
  });

  it('handleInsertMessage: ASSISTANT message cleans streaming bubble of same subAgentId', () => {
    const s = mkSetters();
    s.state.streamingBubbles.set('streamA', {
      text: 'x',
      sequence: 1,
      done: false,
      subAgentId: 'sub1',
    });
    handleInsertMessage(
      {
        agentId: 'me',
        id: 'm1',
        timestamp: 't',
        text: 'assistant',
        role: 'ASSISTANT',
        metadata: { subAgentId: 'sub1' },
      } as never,
      'me',
      s as never,
    );
    expect(s.state.streamingBubbles.size).toBe(0);
  });

  it('handleInsertMessage: ASSISTANT message with streamId cleans only that stream', () => {
    const s = mkSetters();
    s.state.streamingBubbles.set('streamA', {
      text: 'first',
      sequence: 1,
      done: false,
    });
    s.state.streamingBubbles.set('streamB', {
      text: 'second',
      sequence: 1,
      done: false,
    });
    handleInsertMessage(
      {
        agentId: 'me',
        id: 'm1',
        timestamp: 't',
        text: 'assistant',
        role: 'ASSISTANT',
        metadata: { streamId: 'streamA' },
      } as never,
      'me',
      s as never,
    );
    expect(s.state.streamingBubbles.has('streamA')).toBe(false);
    expect(s.state.streamingBubbles.has('streamB')).toBe(true);
  });

  it('handleUpdateAgent: merges partial updates and toggles chat mode', () => {
    const s = mkSetters();
    s.state.agent = {
      progress: 0,
      status: 'ACTIVE',
      temporal_workflow_id: 'wf-old',
    } as never;
    const onLoad = vi.fn();
    handleUpdateAgent(
      {
        progress: 0.5,
        status: 'COMPLETED',
        temporalWorkflowId: null,
      } as never,
      s.setAgent as never,
      s.setIsChatMode as never,
      onLoad,
    );
    expect(s.state.agent.progress).toBe(0.5);
    expect(s.state.agent.status).toBe('COMPLETED');
    expect(s.state.isChatMode).toBe(true);
    expect(onLoad).toHaveBeenCalled();
  });

  it('handleUpdateAgent: no-ops when prev is null', () => {
    const s = mkSetters();
    handleUpdateAgent({} as never, s.setAgent as never, s.setIsChatMode as never);
    expect(s.state.agent).toBeNull();
  });

  it('handleAssistantStream: ignores wrong agentId', () => {
    const s = mkSetters();
    handleAssistantStream(
      { agentId: 'other', stream_id: 'x', sequence: 0, delta: 'd', done: false } as never,
      'me',
      { current: new Set<string>() },
      s.setStreamingBubbles as never,
    );
    expect(s.state.streamingBubbles.size).toBe(0);
  });

  it('handleAssistantStream: accumulates text and records stream on done', () => {
    const s = mkSetters();
    const refSet = new Set<string>();
    const ref = { current: refSet };
    // First chunk
    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 's1',
        sequence: 0,
        delta: 'Hello ',
        done: false,
      } as never,
      'me',
      ref,
      s.setStreamingBubbles as never,
    );
    // Second chunk marks done
    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 's1',
        sequence: 1,
        delta: 'World',
        done: true,
      } as never,
      'me',
      ref,
      s.setStreamingBubbles as never,
    );
    const bubble = s.state.streamingBubbles.get('s1');
    expect(bubble?.text).toBe('Hello World');
    expect(bubble?.done).toBe(true);
    expect(refSet.has('Hello World')).toBe(true);
  });

  it('handleAssistantStream: clears router thinking on done and preserves text dedupe', () => {
    const s = mkSetters();
    const streamedTextsRef = { current: new Set<string>() };
    const completedStreamIdsRef = { current: new Set<string>() };

    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 'router-stream',
        sequence: 1,
        delta: 'Choosing a direct answer',
        done: false,
      },
      'me',
      streamedTextsRef,
      s.setStreamingBubbles,
      completedStreamIdsRef,
    );
    expect(s.state.streamingBubbles.get('router-stream')?.text).toBe('Choosing a direct answer');

    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 'router-stream',
        sequence: 2,
        delta: '',
        done: true,
        clear_on_done: true,
      },
      'me',
      streamedTextsRef,
      s.setStreamingBubbles,
      completedStreamIdsRef,
    );

    expect(s.state.streamingBubbles.has('router-stream')).toBe(false);
    expect(completedStreamIdsRef.current.has('router-stream')).toBe(true);
    expect(streamedTextsRef.current.has('Choosing a direct answer')).toBe(true);
  });

  it('handleAssistantStream: GPT reasoning stream stays ephemeral and tagged', () => {
    const s = mkSetters();
    const refSet = new Set<string>();
    const ref = { current: refSet };

    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 'gpt-reasoning',
        sequence: 0,
        delta: 'thinking ',
        done: false,
        is_gpt: true,
      } as never,
      'me',
      ref,
      s.setStreamingBubbles as never,
    );
    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 'gpt-reasoning',
        sequence: 1,
        delta: 'through',
        done: true,
      } as never,
      'me',
      ref,
      s.setStreamingBubbles as never,
    );

    const bubble = s.state.streamingBubbles.get('gpt-reasoning');
    expect(bubble).toMatchObject({
      text: 'thinking through',
      done: true,
      isGpt: true,
    });
    expect(s.state.messages).toEqual([]);
    expect(refSet.has('thinking through')).toBe(true);
  });

  it('handlePlanStream: stores plan for correct agent', () => {
    const s = mkSetters();
    handlePlanStream(
      {
        agentId: 'me',
        stream_id: 's1',
        tool_call_id: 'tc1',
        title: 'Plan',
        char_count: 10,
        llm_started_at_ms: 1700000000000,
      } as never,
      'me',
      s.setStreamingPlan as never,
    );
    expect(s.state.streamingPlan).toMatchObject({
      title: 'Plan',
      char_count: 10,
      startedAtMs: 1700000000000,
    });
  });

  it('handlePlanStream: ignores wrong agent', () => {
    const s = mkSetters();
    handlePlanStream(
      { agentId: 'other', stream_id: 's1', tool_call_id: 'tc1', title: 'x' } as never,
      'me',
      s.setStreamingPlan as never,
    );
    expect(s.state.streamingPlan).toBeNull();
  });

  it('handleAttentionStream: stores and ignores wrong agent', () => {
    const s = mkSetters();
    handleAttentionStream(
      {
        agentId: 'other',
        stream_id: 's',
        tool_call_id: 'tc',
        message: 'm',
      } as never,
      'me',
      s.setStreamingAttention as never,
    );
    expect(s.state.streamingAttention).toBeNull();
    handleAttentionStream(
      {
        agentId: 'me',
        stream_id: 's',
        tool_call_id: 'tc',
        message: 'hi',
      } as never,
      'me',
      s.setStreamingAttention as never,
    );
    expect(s.state.streamingAttention?.message).toBe('hi');
  });

  it('reconciles keyed attention streams without stale updates or flicker', () => {
    const s = mkSetters();
    const event = (message: string, sequence: number, done = false) => ({
      agentId: 'me',
      stream_id: 'answer-stream',
      tool_call_id: 'answer-tool',
      message,
      is_question: false,
      done,
      sequence,
    });

    handleAttentionStream(event('Hello', 2), 'me', s.setStreamingAttention as never);
    handleAttentionStream(event('Hel', 1), 'me', s.setStreamingAttention as never);
    expect(s.state.streamingAttention?.message).toBe('Hello');

    handleAttentionStream(event('Hello!', 3, true), 'me', s.setStreamingAttention as never);
    expect(s.state.streamingAttention).toMatchObject({
      message: 'Hello!',
      done: true,
      sequence: 3,
    });
    expect(shouldShowStreamingAttention(s.state.streamingAttention, undefined)).toBe(true);

    handleInsertMessage(
      {
        agentId: 'me',
        id: 'reasoning',
        timestamp: '2026-07-13T00:00:00.000Z',
        text: 'reasoning',
        role: 'ASSISTANT',
        metadata: null,
      },
      'me',
      s as never,
    );
    expect(s.state.streamingAttention?.message).toBe('Hello!');

    handleInsertMessage(
      {
        agentId: 'me',
        id: 'unmatched',
        timestamp: '2026-07-13T00:00:01.000Z',
        text: 'other',
        role: 'TOOL',
        metadata: { toolName: 'send_message_to_user', toolCallId: 'other-tool' },
      },
      'me',
      s as never,
    );
    expect(s.state.streamingAttention?.tool_call_id).toBe('answer-tool');

    handleInsertMessage(
      {
        agentId: 'me',
        id: 'canonical',
        timestamp: '2026-07-13T00:00:02.000Z',
        text: 'Hello!',
        role: 'TOOL',
        metadata: { toolName: 'send_message_to_user', toolCallId: 'answer-tool' },
      },
      'me',
      s as never,
    );
    expect(s.state.streamingAttention).toBeNull();

    handleAttentionStream(event('', 4, true), 'me', s.setStreamingAttention as never);
    expect(s.state.streamingAttention).toBeNull();
  });

  it('handleToolStream: adds to map and ignores wrong agent', () => {
    const s = mkSetters();
    handleToolStream(
      {
        agentId: 'other',
        stream_id: 's1',
        tool_call_id: 'tc1',
        tool_name: 'foo',
        title: 't',
      } as never,
      'me',
      s.setStreamingTools as never,
    );
    expect(s.state.streamingTools.size).toBe(0);
    handleToolStream(
      {
        agentId: 'me',
        stream_id: 's1',
        tool_call_id: 'tc1',
        tool_name: 'foo',
        title: 't',
        char_count: 75,
        llm_started_at_ms: 1700000000000,
        is_claude: true,
      } as never,
      'me',
      s.setStreamingTools as never,
    );
    expect(s.state.streamingTools.get('tc1')?.tool_name).toBe('foo');
    expect(s.state.streamingTools.get('tc1')?.charCount).toBe(75);
    expect(s.state.streamingTools.get('tc1')?.startedAtMs).toBe(1700000000000);
    expect(s.state.streamingTools.get('tc1')?.isClaude).toBe(true);
  });

  it('handleToolStream: clears matching ephemeral tool on FINISHED status', () => {
    const s = mkSetters();
    s.state.streamingTools.set('tc1', { tool_call_id: 'tc1', tool_name: 'web_search' } as never);
    handleToolStream(
      {
        agentId: 'me',
        stream_id: 's1',
        tool_call_id: 'tc1',
        tool_name: 'web_search',
        title: 'Finished web_search',
        status: 'FINISHED',
      } as never,
      'me',
      s.setStreamingTools as never,
    );
    expect(s.state.streamingTools.has('tc1')).toBe(false);
  });

  it('cleanupSubscription: resets refs and clears bubbles', () => {
    const s = mkSetters();
    s.state.streamingBubbles.set('x', { text: '', sequence: 0, done: false, timeoutId: 999 });
    s.state.streamingPlan = { stream_id: 'p' } as never;
    s.state.streamingAttention = { stream_id: 'a' } as never;
    s.state.streamingTools.set('tc1', { tool_call_id: 'tc1' } as never);
    const isReconnectingRef = { current: true };
    const reconnectTimeoutRef: { current: number | null } = { current: 123 };
    const channelRef: { current: import('@supabase/supabase-js').RealtimeChannel | null } = {
      current: fakeChannel(),
    };
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    cleanupSubscription(
      isReconnectingRef,
      reconnectTimeoutRef,
      channelRef,
      s.setStreamingBubbles as never,
      s.setStreamingPlan as never,
      s.setStreamingAttention as never,
      s.setStreamingTools as never,
    );
    expect(isReconnectingRef.current).toBe(false);
    expect(reconnectTimeoutRef.current).toBeNull();
    expect(channelRef.current).toBeNull();
    expect(s.state.streamingBubbles.size).toBe(0);
    expect(s.state.streamingPlan).toBeNull();
    expect(s.state.streamingAttention).toBeNull();
    expect(s.state.streamingTools.size).toBe(0);
    clearSpy.mockRestore();
  });
});
