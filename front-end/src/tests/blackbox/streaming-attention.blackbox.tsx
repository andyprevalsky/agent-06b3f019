import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from './test-wrapper';
import { StreamingAttentionBubble } from '@/features/terminal-component-group/components/StreamingMessageItems';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';

describe('keyed streaming attention render lifecycle', () => {
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
