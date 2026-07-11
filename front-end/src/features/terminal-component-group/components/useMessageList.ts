/**
 * Behavioral hooks for MessageList (state machines with side effects).
 * Pure data-filtering hooks live in useMessageFiltering.ts.
 *
 * STATE MACHINES (one per hook):
 *   useMessageAnimationBuffer  — single-slot animation queue
 *   useThinkingVisibility      — debounced show, immediate terminal/blocking hide
 *   useStreamingAutoScroll     — sub-agent-panel auto-scroll to latest
 *   useMessageListState        — composite aggregating all of the above
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react';
import { useAnimatedCounter, type AgentContextValue, type Message } from '../hooks';
import {
  useFilteredMessages,
  useFilteredStreaming,
  useSubAgentTreeMerge,
  type FilteredMessages,
  type FilteredStreamingState,
} from './useMessageFiltering';
import { useThinkingVisibility } from './useThinkingVisibility';

// ─── Animation buffer ────────────────────────────────────────────────────

interface UseMessageAnimationBufferOptions {
  subAgentId: string | undefined;
  registerMessageHandler: (
    subAgentId: string | null,
    handler: (msg: Message) => void,
  ) => () => void;
  streamedTextsRef: MutableRefObject<Set<string>>;
  assistantInsertedRef: MutableRefObject<boolean>;
}

export interface MessageAnimationState {
  isAnimating: boolean;
  currentAnimatingId: string | null;
  messageBufferLength: number;
  handleAnimationComplete: () => void;
}

function shouldAnimateAssistant(
  next: Message,
  streamedTextsRef: MutableRefObject<Set<string>>,
  assistantInsertedRef: MutableRefObject<boolean>,
): boolean {
  assistantInsertedRef.current = true;
  const textKey = (next.text || '').trim();
  if (streamedTextsRef.current.has(textKey)) {
    streamedTextsRef.current.delete(textKey);
    return false;
  }
  return textKey.length > 0;
}

function shouldAnimateTool(next: Message): boolean {
  const isAttention = !!next.metadata?.isUserAttentionMessage;
  if (isAttention) return false;
  const status = next.metadata?.toolStatus;
  const messageText = next.text || '';
  return (status === 'FINISHED' || status === 'ERROR') && messageText.trim().length > 0;
}

export function useMessageAnimationBuffer({
  subAgentId,
  registerMessageHandler,
  streamedTextsRef,
  assistantInsertedRef,
}: UseMessageAnimationBufferOptions): MessageAnimationState {
  const [messageBuffer, setMessageBuffer] = useState<Message[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentAnimatingId, setCurrentAnimatingId] = useState<string | null>(null);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    const unregister = registerMessageHandler(subAgentId ?? null, (message) => {
      setMessageBuffer((prev) => {
        if (prev.some((m) => m.message_id === message.message_id)) return prev;
        return [...prev, message];
      });
    });
    requestAnimationFrame(() => {
      isInitialLoadRef.current = false;
    });
    return () => unregister();
  }, [subAgentId, registerMessageHandler]);

  useEffect(() => {
    if (messageBuffer.length === 0 || isAnimating) return;
    const next = messageBuffer[0];
    setMessageBuffer((prev) => prev.slice(1));

    let shouldAnimate = false;
    if (next.role === 'ASSISTANT') {
      shouldAnimate = shouldAnimateAssistant(next, streamedTextsRef, assistantInsertedRef);
    } else if (next.role === 'TOOL') {
      shouldAnimate = shouldAnimateTool(next);
    }

    if (shouldAnimate) {
      setIsAnimating(true);
      setCurrentAnimatingId(next.message_id);
    }
  }, [messageBuffer, isAnimating, streamedTextsRef, assistantInsertedRef]);

  return {
    isAnimating,
    currentAnimatingId,
    messageBufferLength: messageBuffer.length,
    handleAnimationComplete: () => {
      setIsAnimating(false);
      setCurrentAnimatingId(null);
    },
  };
}

// ─── Streaming auto-scroll (sub-agent panels only) ───────────────────────

export function useStreamingAutoScroll(
  subAgentId: string | undefined,
  scrollEndRef: MutableRefObject<HTMLDivElement | null>,
  streamingBubblesSize: number,
  messageCount: number,
): void {
  useLayoutEffect(() => {
    if (subAgentId === undefined) return;
    if (streamingBubblesSize > 0 && scrollEndRef.current) {
      scrollEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [subAgentId, streamingBubblesSize, scrollEndRef]);

  useLayoutEffect(() => {
    if (subAgentId === undefined) return;
    if (messageCount > 0 && scrollEndRef.current) {
      scrollEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [subAgentId, messageCount, scrollEndRef]);
}

// ─── Composite: everything MessageList needs in one call ─────────────────

export interface UseMessageListStateOptions {
  ctx: AgentContextValue;
  subAgentId: string | undefined;
  showThinkingIndicator: boolean;
  scrollEndRef: RefObject<HTMLDivElement>;
}

export interface MessageListState {
  filtered: FilteredMessages;
  filteredMessages: Message[];
  streaming: FilteredStreamingState;
  animation: MessageAnimationState;
  animatedTokenCount: number;
  thinkingVisible: boolean;
  handleSendMessage: (text: string) => void;
}

export function useMessageListState({
  ctx,
  subAgentId,
  showThinkingIndicator,
  scrollEndRef,
}: UseMessageListStateOptions): MessageListState {
  const assistantInsertedRef = useRef(false);
  const filtered = useFilteredMessages(ctx.messages, subAgentId);
  const filteredMessages = useSubAgentTreeMerge(
    filtered.filteredMessagesRaw,
    subAgentId === undefined ? ctx.selectedAgentId : undefined,
  );

  const streaming = useFilteredStreaming({
    subAgentId,
    streamingBubbles: ctx.streamingBubbles,
    streamingPlan: ctx.streamingPlan,
    streamingAttention: ctx.streamingAttention,
    streamingTools: ctx.streamingTools,
  });

  const animatedTokenCount = useAnimatedCounter(Math.round(streaming.charCount / 4), 0.3);
  const hasBlockingStreamingTool =
    streaming.tools.size > 0 &&
    (streaming.bubbles.size === 0 ||
      [...streaming.tools.values()].some((tool) => streaming.bubbles.has(tool.stream_id)));

  const animation = useMessageAnimationBuffer({
    subAgentId,
    registerMessageHandler: ctx.registerMessageHandler,
    streamedTextsRef: ctx.streamedTextsRef,
    assistantInsertedRef,
  });

  const thinkingVisible = useThinkingVisibility({
    showThinkingIndicator,
    agent: ctx.agent,
    filteredMessages,
    isChatMode: ctx.isChatMode,
    hasStreamingBubbles: streaming.bubbles.size > 0,
    hasStreamingPlan: streaming.plan !== null,
    hasStreamingTools: hasBlockingStreamingTool,
    selectedAgentId: ctx.selectedAgentId,
    assistantInsertedRef,
  });

  useStreamingAutoScroll(subAgentId, scrollEndRef, streaming.bubbles.size, filteredMessages.length);

  const handleSendMessage = useCallback(
    (text: string): void => {
      ctx.sendMessage(text).catch((error: unknown) => {
        console.error('Failed to send message:', error);
      });
    },
    [ctx],
  );

  return {
    filtered,
    filteredMessages,
    streaming,
    animation,
    animatedTokenCount,
    thinkingVisible,
    handleSendMessage,
  };
}
