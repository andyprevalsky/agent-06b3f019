/**
 * Behavioral hooks for MessageList (state machines with side effects).
 * Pure data-filtering hooks live in useMessageFiltering.ts.
 *
 * STATE MACHINES (one per hook):
 *   useMessageAnimationBuffer  — single-slot animation queue
 *   useThinkingVisibility      — debounced + persistence-based show/hide,
 *                                dismissed by active plan/completed status
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
import {
  useAnimatedCounter,
  type AgentContextValue,
  type AgentDetail,
  type Message,
} from '../hooks';
import {
  useFilteredMessages,
  useFilteredStreaming,
  useSubAgentTreeMerge,
  type FilteredMessages,
  type FilteredStreamingState,
} from './useMessageFiltering';

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

// ─── Thinking visibility ─────────────────────────────────────────────────

interface UseThinkingVisibilityOptions {
  showThinkingIndicator: boolean;
  agent: AgentDetail | null;
  filteredMessages: Message[];
  isChatMode: boolean;
  hasStreamingBubbles: boolean;
  hasStreamingPlan: boolean;
  selectedAgentId: string | null;
  assistantInsertedRef: MutableRefObject<boolean>;
}

function isLastAttentionBlocking(last: Message | undefined, isChatMode: boolean): boolean {
  if (!last?.metadata?.isUserAttentionMessage) return false;
  if (isChatMode) return true;
  const isQuestion = (last.metadata?.sendMessageToUser as { isQuestion?: boolean } | undefined)
    ?.isQuestion;
  const toolApproval = (
    last.metadata?.requestUserApproval as { toolApproval?: boolean } | undefined
  )?.toolApproval;
  return isQuestion === true || toolApproval === true;
}

function isLastToolInProgress(last: Message | undefined): boolean {
  return (
    last?.role === 'TOOL' &&
    last.metadata?.toolStatus === 'IN_PROGRESS' &&
    !last.metadata?.isUserAttentionMessage
  );
}

function computeShouldShow(opts: UseThinkingVisibilityOptions): boolean {
  const {
    showThinkingIndicator,
    agent,
    filteredMessages,
    isChatMode,
    hasStreamingBubbles,
    hasStreamingPlan,
  } = opts;
  if (!showThinkingIndicator) return false;

  const isAgentActive =
    agent &&
    agent.status !== 'PAUSED' &&
    agent.status !== 'COMPLETED' &&
    agent.status !== 'FAILED' &&
    agent.status !== 'OUT_OF_CREDITS' &&
    agent.status !== 'COST_LIMIT_REACHED';
  if (!isAgentActive) return false;

  const last = filteredMessages[filteredMessages.length - 1];
  if (isLastToolInProgress(last)) return false;
  if (isLastAttentionBlocking(last, isChatMode)) return false;

  const hasInProgressTool = filteredMessages.some(
    (m) =>
      m.role === 'TOOL' &&
      m.metadata?.toolStatus === 'IN_PROGRESS' &&
      !m.metadata?.isUserAttentionMessage,
  );
  if (hasInProgressTool || hasStreamingPlan) return false;

  if (hasStreamingBubbles) return true;

  return true;
}

export function useThinkingVisibility(opts: UseThinkingVisibilityOptions): boolean {
  const { selectedAgentId, assistantInsertedRef } = opts;
  const [thinkingVisible, setThinkingVisible] = useState(false);
  const prevAgentIdRef = useRef<string | null>(selectedAgentId);
  const showDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shouldShow = computeShouldShow(opts);
  const shouldDismissPersistedThinking =
    opts.hasStreamingPlan || opts.agent?.status === 'COMPLETED';

  useEffect(() => {
    if (showDebounceRef.current) {
      clearTimeout(showDebounceRef.current);
      showDebounceRef.current = null;
    }

    if (prevAgentIdRef.current !== selectedAgentId) {
      prevAgentIdRef.current = selectedAgentId;
      setThinkingVisible(shouldShow);
      assistantInsertedRef.current = false;
      return;
    }

    if (shouldDismissPersistedThinking) {
      setThinkingVisible(false);
      return;
    }

    if (assistantInsertedRef.current) {
      setThinkingVisible(false);
      assistantInsertedRef.current = false;
      return;
    }

    if (shouldShow && !thinkingVisible) {
      showDebounceRef.current = setTimeout(() => setThinkingVisible(true), 800);
    }

    return () => {
      if (showDebounceRef.current) {
        clearTimeout(showDebounceRef.current);
        showDebounceRef.current = null;
      }
    };
  }, [
    shouldShow,
    shouldDismissPersistedThinking,
    selectedAgentId,
    assistantInsertedRef,
    thinkingVisible,
  ]);

  return thinkingVisible;
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
  const filteredMessages = useSubAgentTreeMerge(filtered.filteredMessagesRaw);

  const streaming = useFilteredStreaming({
    subAgentId,
    streamingBubbles: ctx.streamingBubbles,
    streamingPlan: ctx.streamingPlan,
    streamingAttention: ctx.streamingAttention,
    streamingTools: ctx.streamingTools,
  });

  const animatedTokenCount = useAnimatedCounter(Math.round(streaming.charCount / 4), 0.3);

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
