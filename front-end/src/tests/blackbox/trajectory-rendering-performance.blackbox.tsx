import { createRef } from 'react';
import { act, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import {
  MessageListView,
  type MessageListViewProps,
} from '@/features/terminal-component-group/components/MessageListView';
import {
  useMessageAnimationBuffer,
  useStreamingAutoScroll,
} from '@/features/terminal-component-group/components/useMessageList';
import { useFilteredStreaming } from '@/features/terminal-component-group/components/useMessageFiltering';
import { mergeSubAgentTreeMessages } from '@/features/terminal-component-group/components/useSubAgentTreeMerge';
import { EMPTY_WEB_SEARCH_GROUPING } from '@/features/terminal-component-group/components/webSearchTurnGroups';
import type { StreamingBubble, StreamingTool } from '@/features/terminal-component-group/hooks';
import { msg, WithAgent } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';

const tool: StreamingTool = {
  tool_call_id: 'live-call',
  stream_id: 'live-stream',
  tool_name: 'read_file',
  title: 'Reading',
};
const bubble = (text: string): StreamingBubble => ({ text, sequence: 0, done: false });

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

describe('trajectory rendering work follows changed data', () => {
  it('does not rescan persisted history or replace tool projections on bubble token updates', () => {
    let metadataReads = 0;
    const messages = Array.from({ length: 2_000 }, (_, i) => {
      const row = msg({ toolCallId: `saved-${i}` });
      const metadata = row.metadata;
      Object.defineProperty(row, 'metadata', {
        get: () => {
          metadataReads++;
          return metadata;
        },
      });
      return row;
    });
    const options = {
      subAgentId: undefined,
      persistedMessages: messages,
      streamingBubbles: new Map([['stream', bubble('a')]]),
      streamingPlan: null,
      streamingAttention: null,
      streamingTools: new Map([['live-call', tool]]),
    };
    const { result, rerender } = renderHook(useFilteredStreaming, { initialProps: options });
    const tools = result.current.tools;
    metadataReads = 0;
    for (let i = 1; i <= 10; i++) {
      rerender({ ...options, streamingBubbles: new Map([['stream', bubble('a'.repeat(i + 1))]]) });
      expect(result.current.charCount).toBe(i + 1);
    }
    expect(metadataReads).toBe(0);
    expect(result.current.tools).toBe(tools);
    const persisted = [...messages, msg({ toolCallId: 'live-call' })];
    rerender({ ...options, persistedMessages: persisted });
    expect(result.current.tools.size).toBe(0);
  });

  it('does not reproject live history for animated counter frames', () => {
    let timestampReads = 0;
    let historyReads = 0;
    const messages = Array.from({ length: 2_000 }, (_, i) => {
      const row = msg({ toolName: 'read_file', toolCallId: `call-${i}` });
      const metadata = row.metadata;
      const id = row.message_id;
      Object.defineProperty(row, 'metadata', {
        get: () => {
          historyReads++;
          return metadata;
        },
      });
      Object.defineProperty(row, 'message_id', {
        get: () => {
          historyReads++;
          return id;
        },
      });
      const timestamp = row.timestamp;
      Object.defineProperty(row, 'timestamp', {
        get: () => {
          timestampReads++;
          return timestamp;
        },
      });
      return row;
    });
    const props = propsFor(messages);
    const view = (count: number) => (
      <WithAgent messages={messages}>
        <MessageListView {...props} animatedTokenCount={count} />
      </WithAgent>
    );
    const rendered = renderWithProviders(view(0));
    timestampReads = 0;
    historyReads = 0;
    for (let i = 1; i <= 10; i++) rendered.rerender(view(i));
    expect(timestampReads).toBe(0);
    // Only the visible batch lead may be read again, not its 2,000 folded rows.
    expect(historyReads).toBeLessThanOrEqual(100);
    expect(screen.getByTestId('trajectory-activity-line')).toHaveTextContent('Reading');
    expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
  });

  it('releases expanded history when switching to another trajectory with the same batch key', () => {
    const props = propsFor([msg({ toolName: 'read_file' }, { message_id: 'one-work' })]);
    const view = (selectedAgentId: string, messages = props.filteredMessages) => (
      <WithAgent messages={messages} selectedAgentId={selectedAgentId}>
        <MessageListItems
          {...props}
          filteredMessages={messages}
          selectedAgentId={selectedAgentId}
          compressWork
          currentAnimatingId={null}
          onAnimationComplete={props.animation.handleAnimationComplete}
          streamingMetricsBySubAgentId={new Map()}
        />
      </WithAgent>
    );
    const rendered = renderWithProviders(view('one'));
    fireEvent.click(within(screen.getByTestId('trajectory-work-group')).getByRole('button'));
    expect(screen.getByTestId('trajectory-work-history')).toBeInTheDocument();
    const nextMessages = [msg({ toolName: 'read_file' }, { message_id: 'two-work' })];
    rendered.rerender(view('two', nextMessages));
    expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
    expect(within(screen.getByTestId('trajectory-work-group')).getByRole('button')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    fireEvent.click(within(screen.getByTestId('trajectory-work-group')).getByRole('button'));
    expect(document.querySelector('[data-message-id="two-work"]')).not.toBeNull();
    expect(document.querySelector('[data-message-id="one-work"]')).toBeNull();
  });

  it('drains a burst of non-animated receipts in bounded React commits', () => {
    let dispatch!: (message: MessageListViewProps['filteredMessages'][number]) => void;
    const options = {
      selectedAgentId: 'one',
      subAgentId: undefined,
      registerMessageHandler: (_id: string | null, handler: typeof dispatch) => {
        dispatch = handler;
        return () => {};
      },
      streamedTextsRef: { current: new Set<string>() },
      assistantInsertedRef: { current: false },
    };
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useMessageAnimationBuffer(options);
    });
    renders = 0;
    act(() => {
      for (let i = 0; i < 250; i++) dispatch(msg({}, { role: 'USER', message_id: `receipt-${i}` }));
    });
    expect(result.current.isAnimating).toBe(false);
    expect(result.current.messageBufferLength).toBe(0);
    expect(renders).toBeLessThanOrEqual(5);
  });

  it('rejects a retired handler even after switching back to the same agent', () => {
    const handlers: Array<(message: MessageListViewProps['filteredMessages'][number]) => void> = [];
    const options = {
      subAgentId: undefined,
      registerMessageHandler: (_id: string | null, handler: (typeof handlers)[number]) => {
        handlers.push(handler);
        return () => {};
      },
      streamedTextsRef: { current: new Set<string>() },
      assistantInsertedRef: { current: false },
    };
    const { result, rerender } = renderHook(
      ({ selectedAgentId }) => useMessageAnimationBuffer({ ...options, selectedAgentId }),
      { initialProps: { selectedAgentId: 'one' } },
    );
    rerender({ selectedAgentId: 'two' });
    rerender({ selectedAgentId: 'one' });
    act(() => handlers[0](msg({}, { role: 'ASSISTANT', text: 'Retired receipt' })));
    expect(result.current.currentAnimatingId).toBeNull();
    expect(result.current.messageBufferLength).toBe(0);
    act(() =>
      handlers[2](msg({}, { role: 'ASSISTANT', message_id: 'current', text: 'Current receipt' })),
    );
    expect(result.current.currentAnimatingId).toBe('current');
  });

  it('does not let a retired typing callback complete the next message', () => {
    let dispatch!: (message: MessageListViewProps['filteredMessages'][number]) => void;
    const options = {
      selectedAgentId: 'one',
      subAgentId: undefined,
      registerMessageHandler: (_id: string | null, handler: typeof dispatch) => {
        dispatch = handler;
        return () => {};
      },
      streamedTextsRef: { current: new Set<string>(['already streamed']) },
      assistantInsertedRef: { current: false },
    };
    const { result } = renderHook(() => useMessageAnimationBuffer(options));
    act(() => {
      dispatch(msg({}, { role: 'ASSISTANT', message_id: 'streamed', text: 'already streamed' }));
      dispatch(msg({}, { role: 'ASSISTANT', message_id: 'first', text: 'First answer' }));
      dispatch(msg({ toolStatus: 'FINISHED' }, { message_id: 'second', text: 'Tool result' }));
      dispatch(msg({ toolStatus: 'FINISHED' }, { message_id: 'second', text: 'Tool result' }));
    });
    expect(options.streamedTextsRef.current.size).toBe(0);
    expect(options.assistantInsertedRef.current).toBe(true);
    expect(result.current.currentAnimatingId).toBe('first');
    expect(result.current.messageBufferLength).toBe(1);
    const retiredComplete = result.current.handleAnimationComplete;
    act(() => retiredComplete());
    expect(result.current.currentAnimatingId).toBe('second');
    act(() => retiredComplete());
    expect(result.current.currentAnimatingId).toBe('second');
    act(() => result.current.handleAnimationComplete());
    expect(result.current.currentAnimatingId).toBeNull();
    expect(result.current.messageBufferLength).toBe(0);
  });

  it('coalesces simultaneous sub-agent message and stream scrolls without scrolling on stream end', () => {
    const scrollIntoView = vi.fn();
    const element = document.createElement('div');
    element.scrollIntoView = scrollIntoView;
    const scrollEndRef = { current: element };
    const { rerender } = renderHook(
      ({ subAgentId, streams, messages }) =>
        useStreamingAutoScroll(subAgentId, scrollEndRef, streams, messages),
      { initialProps: { subAgentId: 'child' as string | undefined, streams: 1, messages: 1 } },
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'end' });
    scrollIntoView.mockClear();
    rerender({ subAgentId: 'child', streams: 2, messages: 2 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockClear();
    rerender({ subAgentId: 'child', streams: 0, messages: 2 });
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender({ subAgentId: undefined, streams: 1, messages: 3 });
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender({ subAgentId: 'other-child', streams: 1, messages: 3 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('merges 2,000 spawned children without quadratic array membership scans', () => {
    const messages = Array.from({ length: 2_000 }, (_, i) =>
      msg({
        toolName: 'spawn_general_purpose_agent',
        toolCallId: `spawn:${i}`,
        busId: 'root',
        spawnGroupId: 'spawn',
        subAgentIds: [`child-${i}`],
      }),
    );
    let membershipWork = 0;
    const includes = Array.prototype.includes;
    const spy = vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
      this: unknown[],
      value,
      ...args
    ) {
      if (typeof value === 'string' && value.startsWith('child-')) membershipWork += this.length;
      return includes.call(this, value, ...args);
    });
    let merged: ReturnType<typeof mergeSubAgentTreeMessages>;
    try {
      merged = mergeSubAgentTreeMessages(messages);
    } finally {
      spy.mockRestore();
    }
    expect(merged.result).toHaveLength(1);
    expect(merged.result[0].metadata?.subAgentIds).toEqual(
      messages.map((row) => row.metadata?.subAgentIds[0]),
    );
    expect(membershipWork).toBeLessThanOrEqual(messages.length * 2);
  });
});
