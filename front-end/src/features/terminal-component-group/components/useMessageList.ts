/**
 * Behavioral hooks for MessageList (state machines with side effects).
 * Pure data-filtering hooks live in useMessageFiltering.ts.
 *
 * STATE MACHINES (one per hook):
 *   useMessageAnimationBuffer  — single-slot animation queue
 *   useThinkingVisibility      — debounced show, immediate terminal/blocking hide
 *   useStreamingAutoScroll     — sub-agent-panel auto-scroll to latest
 *   useMessageListState        — composite aggregating all of the above, plus
 *                                the main list's per-turn web-search grouping
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  buildStreamingMetricsBySubAgentId,
  type FilteredMessages,
  type FilteredStreamingState,
} from './useMessageFiltering';
import { useThinkingVisibility } from './useThinkingVisibility';
import { useTrajectoryToolRows } from './trajectoryLiveMessages';
import {
  EMPTY_WEB_SEARCH_GROUPING,
  groupWebSearchTurns,
  type WebSearchTurnGrouping,
} from './webSearchTurnGroups';

// ─── Animation buffer ────────────────────────────────────────────────────

interface UseMessageAnimationBufferOptions {
  selectedAgentId: string | null;
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

interface AnimationQueueEntry {
  message: Message;
  next: AnimationQueueEntry | null;
}
function emptyAnimationQueue() {
  return {
    head: null as AnimationQueueEntry | null,
    tail: null as AnimationQueueEntry | null,
    ids: new Set<string>(),
  };
}

export function useMessageAnimationBuffer({
  selectedAgentId,
  subAgentId,
  registerMessageHandler,
  streamedTextsRef,
  assistantInsertedRef,
}: UseMessageAnimationBufferOptions): MessageAnimationState {
  const queueRef = useRef(emptyAnimationQueue());
  const animationEpochRef = useRef(0);
  const [queueRevision, setQueueRevision] = useState(0);
  const [currentAnimatingId, setCurrentAnimatingId] = useState<string | null>(null);
  const selectedAgentIdRef = useRef(selectedAgentId);
  const subAgentIdRef = useRef(subAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  subAgentIdRef.current = subAgentId;

  useLayoutEffect(() => {
    queueRef.current = emptyAnimationQueue();
    animationEpochRef.current++;
    setQueueRevision((revision) => revision + 1);
    setCurrentAnimatingId(null);
    assistantInsertedRef.current = false;
  }, [assistantInsertedRef, selectedAgentId, subAgentId]);

  useEffect(() => {
    let active = true;
    const unregister = registerMessageHandler(subAgentId ?? null, (message) => {
      if (
        !active ||
        selectedAgentIdRef.current !== selectedAgentId ||
        subAgentIdRef.current !== subAgentId
      )
        return;
      const queue = queueRef.current;
      if (queue.ids.has(message.message_id)) return;
      const entry: AnimationQueueEntry = { message, next: null };
      if (queue.tail) queue.tail.next = entry;
      else queue.head = entry;
      queue.tail = entry;
      queue.ids.add(message.message_id);
      setQueueRevision((revision) => revision + 1);
    });
    return () => {
      active = false;
      unregister();
    };
  }, [selectedAgentId, subAgentId, registerMessageHandler]);

  useEffect(() => {
    if (currentAnimatingId !== null) return;
    const queue = queueRef.current;
    if (!queue.head) return;
    // Drain receipts without a visual animation together; enqueue/dequeue never copy history.
    while (queue.head) {
      const next = queue.head.message;
      queue.head = queue.head.next;
      if (!queue.head) queue.tail = null;
      queue.ids.delete(next.message_id);
      const shouldAnimate =
        next.role === 'ASSISTANT'
          ? shouldAnimateAssistant(next, streamedTextsRef, assistantInsertedRef)
          : next.role === 'TOOL' && shouldAnimateTool(next);
      if (shouldAnimate) {
        animationEpochRef.current++;
        setCurrentAnimatingId(next.message_id);
        break;
      }
    }
    setQueueRevision((revision) => revision + 1);
  }, [queueRevision, currentAnimatingId, streamedTextsRef, assistantInsertedRef]);

  const animationEpoch = animationEpochRef.current;
  const handleAnimationComplete = useCallback(() => {
    if (animationEpochRef.current === animationEpoch) setCurrentAnimatingId(null);
  }, [animationEpoch]);
  return {
    isAnimating: currentAnimatingId !== null,
    currentAnimatingId,
    messageBufferLength: queueRef.current.ids.size,
    handleAnimationComplete,
  };
}

// ─── Streaming auto-scroll (sub-agent panels only) ───────────────────────

export function useStreamingAutoScroll(
  subAgentId: string | undefined,
  scrollEndRef: MutableRefObject<HTMLDivElement | null>,
  streamingBubblesSize: number,
  messageCount: number,
): void {
  const previous = useRef<{
    subAgentId: string | undefined;
    scrollEndRef: typeof scrollEndRef;
    streamingBubblesSize: number;
    messageCount: number;
  }>();
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { subAgentId, scrollEndRef, streamingBubblesSize, messageCount };
    if (subAgentId === undefined) return;
    const changedPanel =
      !last || last.subAgentId !== subAgentId || last.scrollEndRef !== scrollEndRef;
    const newStream =
      (changedPanel || last.streamingBubblesSize !== streamingBubblesSize) &&
      streamingBubblesSize > 0;
    const newMessages = (changedPanel || last.messageCount !== messageCount) && messageCount > 0;
    if (newStream || newMessages)
      scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [subAgentId, streamingBubblesSize, messageCount, scrollEndRef]);
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
  webSearchGrouping: WebSearchTurnGrouping;
  handleSendMessage: (text: string) => Promise<void>;
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
    persistedMessages: ctx.messages,
    streamingBubbles: ctx.streamingBubbles,
    streamingPlan: ctx.streamingPlan,
    streamingAttention: ctx.streamingAttention,
    streamingTools: ctx.streamingTools,
  });

  const streamingMetricsBySubAgentId = useMemo(
    () => buildStreamingMetricsBySubAgentId(ctx.streamingBubbles, ctx.streamingTools),
    [ctx.streamingBubbles, ctx.streamingTools],
  );
  const targetStreamingKey = subAgentId ?? '';
  const targetCharCount = streamingMetricsBySubAgentId.get(targetStreamingKey)?.charCount ?? 0;
  const animatedTokenCount = useAnimatedCounter(Math.round(targetCharCount / 4), 0.3);
  const hasBlockingStreamingTool =
    streaming.tools.size > 0 &&
    (streaming.bubbles.size === 0 ||
      [...streaming.tools.values()].some((tool) => streaming.bubbles.has(tool.stream_id)));

  const animation = useMessageAnimationBuffer({
    selectedAgentId: ctx.selectedAgentId,
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
    hasLiveThinkingStream: [...streaming.bubbles.values()].some(
      (bubble) => !bubble.done && (bubble.subAgentId ?? '') === targetStreamingKey,
    ),
    hasStreamingPlan: streaming.plan !== null,
    hasStreamingTools: hasBlockingStreamingTool,
    selectedAgentId: ctx.selectedAgentId,
    assistantInsertedRef,
  });

  useStreamingAutoScroll(subAgentId, scrollEndRef, streaming.bubbles.size, filteredMessages.length);

  // Sub-agent panels keep one row per search; the main list groups each turn.
  const streamingRows = useTrajectoryToolRows(streaming.tools);
  const webSearchGrouping = useMemo(
    () =>
      subAgentId === undefined
        ? groupWebSearchTurns(filteredMessages, streamingRows)
        : EMPTY_WEB_SEARCH_GROUPING,
    [subAgentId, filteredMessages, streamingRows],
  );

  const sendMessage = ctx.sendMessage;
  const handleSendMessage = useCallback(
    (text: string): Promise<void> => sendMessage(text),
    [sendMessage],
  );

  return {
    filtered,
    filteredMessages,
    streaming,
    animation,
    animatedTokenCount,
    thinkingVisible,
    webSearchGrouping,
    handleSendMessage,
  };
}
