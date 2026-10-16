import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from './test-wrapper';
import { StreamingAttentionBubble } from '@/features/terminal-component-group/components/StreamingMessageItems';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import { AgentContext } from '@/features/agent-context';
import type { AgentDetailResponse, Message } from '@/lib/api';
import { applyAgentBackfill } from '@/features/agent-context/hooks/agentBackfill';
import {
  handleAttentionStream,
  handleInsertMessage,
} from '@/features/agent-context/hooks/realtimeHandlers';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { makeAgentCtx } from './message-bubble.fixtures';
import { mkSetters } from './realtime-handlers.fixtures';

// Minimal captured canonical reply from prod agent 0a3ec6f7-a8ce-4996-bf98-7ef8f3af82c7.
// The user confirmed a duplicated reply; its original client event order was not retained.
const capturedAnswer: Message = {
  message_id: 'fe1c5876-5d62-4405-8ee4-3e9a393a0747',
  timestamp: '2026-10-16T20:07:34.612Z',
  role: 'TOOL',
  text: 'Hey. You still thinking about the speedrun application, or something else on your mind?',
  metadata: {
    toolCallId: '5acf7661-9775-4006-93da-807dce4b3fa4',
    toolName: 'send_message_to_user',
    toolStatus: 'FINISHED',
    isUserAttentionMessage: true,
    attentionMessage:
      'Hey. You still thinking about the speedrun application, or something else on your mind?',
  },
};

describe('keyed streaming attention render lifecycle', () => {
  it.each(['snapshot after stream', 'late stream after snapshot'])(
    'renders one answer with %s while preserving an unrelated active tool',
    (ordering) => {
      const agentId = '0a3ec6f7-a8ce-4996-bf98-7ef8f3af82c7';
      const attention = {
        stream_id: 'captured-answer-stream',
        tool_call_id: capturedAnswer.metadata!.toolCallId!,
        message: capturedAnswer.text,
        is_question: false,
        sequence: 1,
        done: false,
      };
      const ctx = makeAgentCtx({
        selectedAgentId: agentId,
        streamingAttention: ordering === 'snapshot after stream' ? attention : null,
        streamingTools: new Map([
          [
            'unrelated-active-tool',
            {
              stream_id: 'unrelated-stream',
              tool_call_id: 'unrelated-active-tool',
              tool_name: 'web_fetch',
              title: 'Reading unrelated source',
            },
          ],
        ]),
      });
      const list = () => (
        <AgentContext.Provider value={{ ...ctx }}>
          <MessageList showStatusBanners={false} showThinkingIndicator={false} />
        </AgentContext.Provider>
      );
      const view = renderWithProviders(list());
      if (ordering === 'snapshot after stream') {
        expect(view.getAllByText(capturedAnswer.text)).toHaveLength(1);
      }

      applyAgentBackfill(
        { agent: { agent_id: agentId }, messages: [capturedAnswer] } as AgentDetailResponse,
        (action) => {
          ctx.messages = typeof action === 'function' ? action(ctx.messages) : action;
        },
        () => {},
        () => {},
      );
      view.rerender(list());
      expect(view.getAllByText(capturedAnswer.text)).toHaveLength(1);

      handleAttentionStream(
        { ...attention, agentId, sequence: 2, done: true },
        agentId,
        (action) => {
          ctx.streamingAttention =
            typeof action === 'function' ? action(ctx.streamingAttention) : action;
        },
      );
      view.rerender(list());
      expect(view.getAllByText(capturedAnswer.text)).toHaveLength(1);
      expect(
        view.container.querySelector('[data-stream-kind="final-answer"]'),
      ).not.toBeInTheDocument();
      expect(view.getByText('Reading unrelated source')).toBeInTheDocument();
    },
  );

  it('keeps a late attention frame superseded by its canonical INSERT', () => {
    const agentId = '0a3ec6f7-a8ce-4996-bf98-7ef8f3af82c7';
    const setters = mkSetters();
    handleInsertMessage(
      {
        agentId,
        id: capturedAnswer.message_id,
        timestamp: capturedAnswer.timestamp,
        text: capturedAnswer.text,
        role: capturedAnswer.role,
        metadata: capturedAnswer.metadata,
      },
      agentId,
      setters,
    );
    handleAttentionStream(
      {
        agentId,
        stream_id: 'late-answer-stream',
        tool_call_id: capturedAnswer.metadata!.toolCallId!,
        message: capturedAnswer.text,
        is_question: false,
        sequence: 2,
        done: true,
      },
      agentId,
      setters.setStreamingAttention,
    );
    const ctx = makeAgentCtx({ selectedAgentId: agentId, ...setters.state });
    const view = renderWithProviders(
      <AgentContext.Provider value={ctx}>
        <MessageList showStatusBanners={false} showThinkingIndicator={false} />
      </AgentContext.Provider>,
    );
    expect(view.getAllByText(capturedAnswer.text)).toHaveLength(1);
    expect(
      view.container.querySelector('[data-stream-kind="final-answer"]'),
    ).not.toBeInTheDocument();
  });

  it('preserves a new reply stream even when its text repeats an earlier answer', () => {
    const ctx = makeAgentCtx({
      selectedAgentId: '0a3ec6f7-a8ce-4996-bf98-7ef8f3af82c7',
      messages: [capturedAnswer],
      streamingAttention: {
        stream_id: 'new-answer-stream',
        tool_call_id: 'new-answer-tool',
        message: capturedAnswer.text,
        is_question: false,
        sequence: 1,
        done: false,
      },
    });
    const view = renderWithProviders(
      <AgentContext.Provider value={ctx}>
        <MessageList showStatusBanners={false} showThinkingIndicator={false} />
      </AgentContext.Provider>,
    );
    expect(view.getAllByText(capturedAnswer.text)).toHaveLength(2);
    expect(
      view.container.querySelector(
        '[data-stream-kind="final-answer"][data-tool-call-id="new-answer-tool"]',
      ),
    ).toBeInTheDocument();
  });

  it('exposes a deterministic ephemeral answer identity and terminal state', () => {
    const { container, rerender } = renderWithProviders(
      <StreamingAttentionBubble
        attention={{
          stream_id: 'answer-stream',
          tool_call_id: 'answer-tool',
          message: 'Hello',
          is_question: false,
          sequence: 1,
          done: false,
        }}
        onSendMessage={vi.fn()}
      />,
    );

    const selector = '[data-stream-kind="final-answer"][data-tool-call-id="answer-tool"]';
    expect(container.querySelector(selector)).toHaveAttribute('data-stream-state', 'streaming');

    rerender(
      <StreamingAttentionBubble
        attention={{
          stream_id: 'answer-stream',
          tool_call_id: 'answer-tool',
          message: 'Hello!',
          is_question: false,
          sequence: 2,
          done: true,
        }}
        onSendMessage={vi.fn()}
      />,
    );
    expect(container.querySelector(selector)).toHaveAttribute('data-stream-state', 'terminal');
  });

  it('exposes the matching canonical answer identity', () => {
    const { container } = renderWithProviders(
      <MessageListItems
        streamingMetricsBySubAgentId={new Map()}
        filteredMessages={[
          {
            message_id: 'canonical-message',
            role: 'TOOL',
            text: 'Hello!',
            timestamp: '2026-07-13T00:00:00.000Z',
            metadata: {
              toolCallId: 'answer-tool',
              toolName: 'send_message_to_user',
              toolStatus: 'FINISHED',
              isUserAttentionMessage: true,
              attentionMessage: 'Hello!',
            },
          },
        ]}
        currentAnimatingId={null}
        onAnimationComplete={vi.fn()}
        selectedAgentId="agent"
        onSendMessage={vi.fn()}
        exploreStepMap={new Map()}
        waitForCheckMap={new Map()}
      />,
    );

    expect(
      container.querySelector(
        '[data-message-kind="final-answer"][data-message-state="canonical"]' +
          '[data-tool-call-id="answer-tool"]',
      ),
    ).toHaveAttribute('data-message-id', 'canonical-message');
  });
});
