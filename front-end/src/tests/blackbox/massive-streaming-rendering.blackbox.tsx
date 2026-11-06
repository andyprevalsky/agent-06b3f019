import { createRef } from 'react';
import { renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  MessageListView,
  type MessageListViewProps,
} from '@/features/terminal-component-group/components/MessageListView';
import { EMPTY_WEB_SEARCH_GROUPING } from '@/features/terminal-component-group/components/webSearchTurnGroups';
import type { StreamingTool } from '@/features/terminal-component-group/hooks';
import { msg, WithAgent } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';
import { makeAgentCtx } from './message-bubble.fixtures';
import { useMessageListState } from '@/features/terminal-component-group/components/useMessageList';
const tool: StreamingTool = {
  tool_call_id: 'live-call',
  stream_id: 'live-stream',
  tool_name: 'read_file',
  title: 'Reading',
};
function propsFor(messages: MessageListViewProps['filteredMessages']): MessageListViewProps {
  return {
    containerRef: createRef(),
    scrollEndRef: createRef(),
    containerClassName: '',
    subAgentId: undefined,
    compact: false,
    showStatusBanners: false,
    thinkingVisible: false,
    chatActionsVisible: false,
    agent: null,
    selectedAgentId: 'one',
    filteredMessages: messages,
    webSearchGrouping: EMPTY_WEB_SEARCH_GROUPING,
    exploreStepMap: new Map(),
    waitForCheckMap: new Map(),
    streaming: {
      bubbles: new Map(),
      plan: null,
      attention: null,
      tools: new Map([['live-call', tool]]),
      charCount: 0,
      isClaude: false,
      isGpt: false,
    },
    streamingBubbles: new Map(),
    streamingTools: new Map([['live-call', tool]]),
    animation: {
      isAnimating: false,
      currentAnimatingId: null,
      messageBufferLength: 0,
      handleAnimationComplete: () => {},
    },
    animatedTokenCount: 0,
    onSendMessage: () => {},
  };
}

describe('massive trajectory live tool updates', () => {
  it('keeps turn grouping stable through actual tool stream frames over 100k persisted rows', () => {
    let reads = 0;
    const messages = Array.from({ length: 100_000 }, (_, index) => {
      const message = msg({
        toolName: index % 2 ? 'web_search' : 'read_file',
        toolCallId: `saved-${index}`,
      });
      const metadata = message.metadata;
      Object.defineProperty(message, 'metadata', {
        get: () => {
          reads++;
          return metadata;
        },
      });
      return message;
    });
    const ctx = makeAgentCtx({ messages, selectedAgentId: 'one' });
    const scrollEndRef = createRef<HTMLDivElement>();
    const { result, rerender, unmount } = renderHook(
      ({ charCount }) =>
        useMessageListState({
          ctx: { ...ctx, streamingTools: new Map([['live-call', { ...tool, charCount }]]) },
          subAgentId: undefined,
          showThinkingIndicator: false,
          scrollEndRef,
        }),
      { initialProps: { charCount: 1 } },
    );
    const grouping = result.current.webSearchGrouping;
    reads = 0;
    for (let index = 2; index <= 4; index++) rerender({ charCount: index });
    expect(result.current.streaming.charCount).toBe(4);
    process.stdout.write(`100k composite tool metric history reads: ${reads}\n`);
    expect(reads).toBe(0);
    expect(result.current.webSearchGrouping).toBe(grouping);
    unmount();
  });

  it('updates live tool byte metrics over 100k rows without re-reading unchanged history', () => {
    let reads = 0;
    const messages = Array.from({ length: 100_000 }, (_, index) => {
      const message = msg({ toolName: 'read_file', toolCallId: `saved-${index}` });
      const metadata = message.metadata;
      Object.defineProperty(message, 'metadata', {
        get: () => {
          reads++;
          return metadata;
        },
      });
      return message;
    });
    const props = propsFor(messages);
    const view = (charCount: number, title = 'Reading', active = true) => {
      const tools = new Map(active ? [['live-call', { ...tool, charCount, title }]] : []);
      return (
        <WithAgent messages={messages}>
          <MessageListView
            {...props}
            streamingTools={tools}
            streaming={{ ...props.streaming, tools, charCount }}
          />
        </WithAgent>
      );
    };
    const rendered = renderWithProviders(view(1));
    reads = 0;
    for (let index = 2; index <= 4; index++) rendered.rerender(view(index));
    const historyReads = reads;
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent('Reading');
    process.stdout.write(`100k live tool metric history reads: ${historyReads}\n`);
    expect(historyReads).toBeLessThanOrEqual(100);
    rendered.rerender(view(5, 'Reading updated file'));
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent(
      'Reading updated file',
    );
    rendered.rerender(view(0, 'Reading updated file', false));
    expect(screen.getByTestId('trajectory-activity-line')).not.toHaveTextContent(
      'Reading updated file',
    );
    rendered.rerender(view(6, 'New live tool'));
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent('New live tool');
    rendered.unmount();
  });
});
