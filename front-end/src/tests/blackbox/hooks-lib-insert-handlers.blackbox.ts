import { describe, expect, it } from 'vitest';
import { handleInsertMessage } from '@/features/agent-context/hooks/realtimeHandlers';
import { mkSetters } from './realtime-handlers.fixtures';

describe('realtime INSERT handlers', () => {
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
    s.state.streamingPlan = { stream_id: 'x', tool_call_id: 'tc1' } as never;
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
});
