/**
 * STATE MACHINE: MessageList
 *
 * MESSAGE ANIMATION QUEUE:
 * [IDLE] --> processes messages one at a time
 *     |
 *     v (new message to animate)
 * [ANIMATING] <-- typingMessageId: string | null
 *     |
 *     v (animation complete)
 * [IDLE]
 *
 * MESSAGE FILTERING:
 * ├─ Filter by subAgentId (main chat vs sub-agent panels)
 * ├─ Filter out SYSTEM role messages
 * ├─ Filter out hidden messages (metadata.hidden === true, e.g., custom system prompt)
 * ├─ Deduplicate tool messages by toolCallId
 * ├─ Group explore agent messages by taskId (one chip per explore session, hide internal grep/web_search)
 * └─ Group wait_for messages by toolCallId (preserve check history as steps)
 *
 * THINKING DISPLAY:
 * Show when ALL conditions met (with 500ms debounce):
 * ├─ agent.status is active (not PAUSED/COMPLETED/FAILED/OUT_OF_CREDITS/COST_LIMIT_REACHED)
 * ├─ filteredStreamingBubbles.size > 0 (LLM streaming) OR no IN_PROGRESS tools
 * └─ NOT (last message is send_message_to_user with isQuestion == true)
 *     OR in chat mode: NOT (last message is send_message_to_user at all)
 *
 * Debounce: 800ms delay before showing (cancelled if conditions become false)
 *
 * Persistence rule (once shown, only dismiss when):
 * ├─ selectedAgent changes
 * └─ OR ASSISTANT message INSERT arrives
 *
 * AUTO-SCROLL:
 * [ENABLED] <-- userScrolled: false
 *     |
 *     | (user scrolls up)
 *     v
 * [DISABLED] <-- userScrolled: true
 *     |
 *     | (scroll to bottom)
 *     v
 * [ENABLED]
 *
 * NOTE: FeedbackBanner is now rendered within MessageBubble when isFinalSummary message arrives,
 * not based on agent status. See MessageBubble isCompletionSummary handling.
 *
 * States:
 * - typingMessageId: string | null
 * - userScrolled: boolean
 * - thinkingVisible: boolean (with persistence)
 */

import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useAgentContext, StreamingBubble } from '@/contexts/AgentContext';
import { type Message, startAgent } from '@/lib/api';
import MessageBubble from './MessageBubble';
import { type ExploreStep } from './ExploreAgentBubble';
import { type WaitForCheck } from './WaitForChip';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { Button } from '@/components/ui/button';
import { type FeedbackData } from './FeedbackBanner';
import { Copy, ArrowDown } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAnimatedCounter } from '@/hooks/useAnimatedCounter';

// Claude orange gradient palette for thinking animation SVG recoloring
// Warm terracotta tones centered on Claude's brand orange
const CLAUDE_GRADIENT = ['#F5C4A1', '#E8976A', '#D97757', '#CC5B33', '#B84A22', '#9E3A18'];

// ═══════════════════════════════════════════════════════════════════════════════
// StreamingMarkdown - Renders text with fade-in animation for each chunk
// ═══════════════════════════════════════════════════════════════════════════════

function StreamingMarkdown({ text }: { text: string }) {
  const prevTextRef = useRef('');
  const [chunks, setChunks] = useState<string[]>([]);

  useEffect(() => {
    if (text.length > prevTextRef.current.length) {
      const delta = text.slice(prevTextRef.current.length);
      setChunks((prev) => [...prev, delta]);
      prevTextRef.current = text;
    } else if (text !== prevTextRef.current) {
      setChunks([text]);
      prevTextRef.current = text;
    }
  }, [text]);

  return (
    <span className="text-sm text-muted-foreground">
      {chunks.map((chunk, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          {chunk}
        </motion.span>
      ))}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════════════

function deduplicateToolMessages(
  messages: Message[],
): [Message[], Map<string, ExploreStep[]>, Map<string, WaitForCheck[]>] {
  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Find timestamp of last ASSISTANT message with text - used to clean up orphaned IN_PROGRESS tools
  // Exclude empty ASSISTANT messages (e.g., file_pointer relays from sub-agents)
  // Exclude DAG reasoning ASSISTANT messages - they run in parallel with other tools
  // and should not trigger orphaned cleanup of legitimately running IN_PROGRESS tools
  const lastAssistantTimestamp =
    sortedMessages
      .filter((m) => m.role === 'ASSISTANT' && m.text?.trim() && m.metadata?.dagTaskIndex == null)
      .map((m) => new Date(m.timestamp).getTime())
      .pop() ?? 0;

  // Collect raw wait_for messages BEFORE dedup collapse (for step history)
  const rawWaitForByToolCallId = new Map<string, Message[]>();
  for (const m of sortedMessages) {
    if (m.role === 'TOOL' && m.metadata?.toolName === 'wait_for') {
      const toolCallId = m.metadata?.toolCallId;
      if (toolCallId) {
        const existing = rawWaitForByToolCallId.get(toolCallId) || [];
        existing.push(m);
        rawWaitForByToolCallId.set(toolCallId, existing);
      }
    }
  }

  const toolMessageMap = new Map<string, { message: Message; firstTimestamp: string }>();
  const nonToolMessages: Message[] = [];

  sortedMessages.forEach((message) => {
    if (message.role === 'TOOL') {
      const toolCallId = message.metadata?.toolCallId;

      if (!toolCallId) {
        console.error('Tool message missing toolCallId in metadata:', message);
        nonToolMessages.push(message);
        return;
      }

      const existing = toolMessageMap.get(toolCallId);

      if (existing) {
        const isAttention = !!message.metadata?.isUserAttentionMessage;
        const isWaitFor = message.metadata?.toolName === 'wait_for';
        toolMessageMap.set(toolCallId, {
          message:
            isAttention || isWaitFor
              ? { ...message, message_id: existing.message.message_id }
              : message,
          firstTimestamp: existing.firstTimestamp,
        });
      } else {
        toolMessageMap.set(toolCallId, {
          message: message,
          firstTimestamp: message.timestamp,
        });
      }
    } else {
      nonToolMessages.push(message);
    }
  });

  const deduplicatedToolMessages = Array.from(toolMessageMap.values()).map(
    ({ message, firstTimestamp }) => ({
      ...message,
      timestamp: firstTimestamp,
    }),
  );

  // Clean up orphaned IN_PROGRESS tools from failed LLM calls
  // If an ASSISTANT message came AFTER an IN_PROGRESS tool, that tool is orphaned
  const cleanedToolMessages = deduplicatedToolMessages.filter((m) => {
    // Keep all FINISHED/ERROR tools
    if (m.metadata?.toolStatus !== 'IN_PROGRESS') return true;

    // Keep user attention IN_PROGRESS (different lifecycle - waiting for user)
    if (m.metadata?.isUserAttentionMessage) return true;

    // Keep explore agent messages (they have their own lifecycle managed by explore grouping)
    if (m.metadata?.agentType === 'explore') return true;

    // Keep wait_for messages (long-running with their own lifecycle)
    if (m.metadata?.toolName === 'wait_for') return true;

    // For other IN_PROGRESS, only keep if it came after the last ASSISTANT message
    const toolTime = new Date(m.timestamp).getTime();
    return toolTime >= lastAssistantTimestamp;
  });

  // Compress set_plan messages - only keep the latest one
  const latestSetPlan = cleanedToolMessages
    .filter((m) => m.metadata?.toolName === 'set_plan')
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

  const withCompressedPlans = cleanedToolMessages.filter(
    (m) => m.metadata?.toolName !== 'set_plan' || m.message_id === latestSetPlan?.message_id,
  );

  // Group explore agent messages by taskId.
  // Each taskId has:
  //   - One init message (spawn_agent, toolCallId=init_tool_call_id) → the "chip" representative
  //   - Tool action messages (grep, web_search, web_fetch) → steps inside the chip
  //   - Thinking messages (spawn_agent, title="Explore agent thinking") → shown as thinking steps
  //
  // Standard dedup already collapsed each toolCallId's IN_PROGRESS → FINISHED.
  // We collect them by taskId, pick the init message as representative, and attach steps.
  const exploreMessagesByTask = new Map<string, Message[]>();

  for (const m of withCompressedPlans) {
    if (m.metadata?.agentType === 'explore') {
      const taskId = m.metadata?.taskId as string;
      if (taskId) {
        const existing = exploreMessagesByTask.get(taskId) || [];
        existing.push(m);
        exploreMessagesByTask.set(taskId, existing);
      }
    }
  }

  const exploreRepresentatives = new Set<string>();
  const exploreHidden = new Set<string>();
  const exploreStepMap = new Map<string, ExploreStep[]>();
  // taskId → pre-built explore data for reuse by wait_for checks
  const exploreDataByTaskId = new Map<
    string,
    {
      repMessageId: string;
      title: string;
      fullGoal?: string;
      message: string;
      status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
      steps: ExploreStep[];
    }
  >();

  for (const [taskId, msgs] of exploreMessagesByTask) {
    // Sort chronologically (oldest first)
    msgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Pick representative: the init spawn_agent message (first one, or terminal one)
    const terminalSpawn = msgs.find(
      (m) =>
        m.metadata?.toolName === 'spawn_agent' &&
        (m.metadata?.toolStatus === 'FINISHED' || m.metadata?.toolStatus === 'ERROR'),
    );
    const firstSpawn = msgs.find((m) => m.metadata?.toolName === 'spawn_agent');
    const representative = terminalSpawn || firstSpawn || msgs[0];

    // Steps = all non-representative messages, sorted chronologically (newest at bottom)
    const steps: ExploreStep[] = msgs
      .filter((m) => m.message_id !== representative.message_id)
      .map((m) => {
        const status = (m.metadata?.toolStatus as string) || 'IN_PROGRESS';
        const title = (m.metadata?.title as string) || '';
        // Thinking messages (spawn_agent with title "Explore agent thinking") carry content even when IN_PROGRESS
        const isThinking =
          m.metadata?.toolName === 'spawn_agent' && title === 'Explore agent thinking';
        // IN_PROGRESS messages repeat the title as the message body — show empty instead
        // Exception: thinking messages carry the actual thinking text
        const message = status === 'IN_PROGRESS' && !isThinking ? '' : m.text || '';
        return {
          title,
          status,
          timestamp: m.timestamp,
          message,
          toolName: (m.metadata?.toolName as string) || '',
        };
      });

    exploreStepMap.set(representative.message_id, steps);
    exploreRepresentatives.add(representative.message_id);

    // Store pre-built explore data keyed by taskId for wait_for reuse
    exploreDataByTaskId.set(taskId, {
      repMessageId: representative.message_id,
      title: (representative.metadata?.title as string) || '',
      fullGoal: (representative.metadata?.data?.goal as string) || undefined,
      message: representative.text || '',
      status: ((representative.metadata?.toolStatus as string) || 'IN_PROGRESS') as
        | 'IN_PROGRESS'
        | 'FINISHED'
        | 'ERROR',
      steps,
    });

    for (const m of msgs) {
      if (m.message_id !== representative.message_id) {
        exploreHidden.add(m.message_id);
      }
    }
  }

  const withExploreGrouped = withCompressedPlans.filter((m) => {
    if (exploreRepresentatives.has(m.message_id)) return true;
    if (exploreHidden.has(m.message_id)) return false;
    return true;
  });

  // Build step history for wait_for messages from raw pre-dedup data.
  // Standard dedup collapsed multiple wait_for events (same toolCallId) into the latest one.
  // We reconstruct the check history from the raw messages collected before dedup.
  // Explore data is looked up from exploreDataByTaskId (built once above, not re-processed).
  const waitForCheckMap = new Map<string, WaitForCheck[]>();
  const waitForChildExploreIds = new Set<string>(); // explore representatives owned by wait_for

  for (const [toolCallId, rawMsgs] of rawWaitForByToolCallId) {
    if (rawMsgs.length <= 1) continue;
    rawMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Find the representative (dedup'd message) in the current list
    const representative = withExploreGrouped.find((m) => m.metadata?.toolCallId === toolCallId);
    if (!representative) continue;

    // Build checks from raw messages:
    // - Exclude the initial event (no checkNum — it's "Waiting for X", not a check)
    // - Deduplicate by checkNum: each check emits "checking..." then a result;
    //   keep only the latest message per checkNum (the result)
    // - Include the representative — it naturally wins its checkNum in dedup
    const withCheckNum = rawMsgs.filter((m) => m.metadata?.checkNum != null);

    // Dedup by checkNum: later message wins (rawMsgs already sorted chronologically)
    const latestByCheckNum = new Map<number, Message>();
    for (const m of withCheckNum) {
      latestByCheckNum.set(m.metadata!.checkNum as number, m);
    }

    const checks: WaitForCheck[] = Array.from(latestByCheckNum.values()).map((m) => {
      const exploreTaskId = m.metadata?.exploreTaskId as string | undefined;

      // Look up pre-built explore data by taskId (single source of truth, no re-processing)
      let explore: WaitForCheck['explore'] = undefined;
      if (exploreTaskId) {
        const data = exploreDataByTaskId.get(exploreTaskId);
        if (data) {
          waitForChildExploreIds.add(data.repMessageId);
          explore = {
            title: data.title,
            fullGoal: data.fullGoal,
            message: data.message,
            status: data.status,
            steps: data.steps,
          };
        }
      }

      return {
        title: (m.metadata?.title as string) || '',
        status: ((m.metadata?.toolStatus as string) || 'IN_PROGRESS') as WaitForCheck['status'],
        timestamp: m.timestamp,
        message: m.text || '',
        checkNum: m.metadata?.checkNum as number | undefined,
        maxChecks: m.metadata?.maxChecks as number | undefined,
        conditionMet: m.metadata?.conditionMet as boolean | undefined,
        exploreTaskId,
        explore,
      };
    });

    // Representative is already included in latestByCheckNum (it wins naturally as the
    // chronologically last message for its checkNum). No separate re-addition needed.

    waitForCheckMap.set(representative.message_id, checks);
  }

  // Filter out explore agents that are children of wait_for (they render inside WaitForChip)
  const withWaitForChildrenHidden = withExploreGrouped.filter(
    (m) => !waitForChildExploreIds.has(m.message_id),
  );

  const deduplicatedMessages = [...nonToolMessages, ...withWaitForChildrenHidden];
  deduplicatedMessages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return [deduplicatedMessages, exploreStepMap, waitForCheckMap];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MessageList Props
// ═══════════════════════════════════════════════════════════════════════════════

interface MessageListProps {
  /** Filter messages by subAgentId. undefined = main chat (messages without subAgentId) */
  subAgentId?: string;
  /** Container className for layout customization */
  containerClassName?: string;
  /** Show status banners (paused, completed, out of credits) */
  showStatusBanners?: boolean;
  /** Show thinking indicator */
  showThinkingIndicator?: boolean;
  /** Compact mode - removes left spacers for tighter layouts */
  compact?: boolean;
  /** Callback when user clicks "Add Credits" on out of credits banner */
  onAddCredits?: () => void;
  /** Callback when user clicks "Increase Cost Limit" on cost limit reached banner */
  onIncreaseCostLimit?: () => void;
  /** Callback when navigating to a sub-agent */
  onNavigateToAgent?: (agentId: string) => void;
  /** Callback when user submits feedback */
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MessageList Component
// ═══════════════════════════════════════════════════════════════════════════════

export function MessageList({
  subAgentId,
  containerClassName = 'max-w-4xl mx-auto flex flex-col gap-1.5 pb-32 relative z-20',
  showStatusBanners = true,
  showThinkingIndicator = true,
  compact = false,
  onAddCredits,
  onIncreaseCostLimit,
  onNavigateToAgent,
  onSubmitFeedback,
}: MessageListProps) {
  const {
    agent,
    messages,
    streamingBubbles,
    streamingPlan,
    streamingAttention,
    streamingTools,
    streamedTextsRef,
    registerMessageHandler,
    sendMessage,
    selectedAgentId,
    isChatMode,
  } = useAgentContext();

  const { toast } = useToast();

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCAL BUFFER STATE (independent per MessageList instance)
  // ═══════════════════════════════════════════════════════════════════════════

  const [messageBuffer, setMessageBuffer] = useState<Message[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentAnimatingId, setCurrentAnimatingId] = useState<string | null>(null);

  // Track if this is initial load (skip animation for existing messages)
  const isInitialLoadRef = useRef(true);

  // ═══════════════════════════════════════════════════════════════════════════
  // FILTER MESSAGES for this subAgentId
  // ═══════════════════════════════════════════════════════════════════════════

  const filteredMessagesAndSteps = useMemo(() => {
    const targetSubAgentId = subAgentId ?? null;

    // Filter messages for this subAgentId
    const filtered = messages.filter((m) => {
      const msgSubAgentId = m.metadata?.subAgentId ?? null;
      // Main chat (null) shows messages without subAgentId
      // Exception: explore agent internal messages use subAgentId for LLM filtering
      // but are grouped/hidden by deduplicateToolMessages via taskId
      if (targetSubAgentId === null) {
        if (msgSubAgentId === null) return true;
        if (m.metadata?.agentType === 'explore') return true;
        return false;
      }
      return msgSubAgentId === targetSubAgentId;
    });

    // Filter out SYSTEM messages
    const withoutSystem = filtered.filter((m) => m.role !== 'SYSTEM');

    // Filter out hidden messages (e.g., custom system prompt injection)
    const withoutHidden = withoutSystem.filter((m) => !m.metadata?.hidden);

    // Deduplicate tool messages
    return deduplicateToolMessages(withoutHidden);
  }, [messages, subAgentId]);

  const [filteredMessagesRaw, exploreStepMap, waitForCheckMap] = filteredMessagesAndSteps;

  // ═══════════════════════════════════════════════════════════════════════════
  // MERGE SUB-AGENT TREES by busId into single renders
  // Groups all spawn_sub_agent tree messages sharing the same busId,
  // regardless of whether other messages sit between them.
  // ═══════════════════════════════════════════════════════════════════════════

  const prevMergedRef = useRef<Map<string, Message>>(new Map());

  const filteredMessages = useMemo(() => {
    const isSpawnTree = (m: Message) =>
      m.metadata?.toolName === 'spawn_sub_agent' &&
      Array.isArray(m.metadata?.subAgentIds) &&
      (m.metadata.subAgentIds as string[]).length > 0 &&
      !!m.metadata?.busId;

    // Pass 1: group spawn tree messages by busId
    const groupsByBus = new Map<string, { firstIndex: number; ids: string[]; firstMsg: Message }>();
    const skipIndices = new Set<number>();

    for (let i = 0; i < filteredMessagesRaw.length; i++) {
      const msg = filteredMessagesRaw[i];
      if (!isSpawnTree(msg)) continue;
      const busId = msg.metadata!.busId as string;
      const group = groupsByBus.get(busId);
      if (group) {
        group.ids.push(...(msg.metadata!.subAgentIds as string[]));
        skipIndices.add(i);
      } else {
        groupsByBus.set(busId, {
          firstIndex: i,
          ids: [...(msg.metadata!.subAgentIds as string[])],
          firstMsg: msg,
        });
      }
    }

    // Pass 2: build result, replacing first occurrence per group with merged message
    const newMergedCache = new Map<string, Message>();
    const result: Message[] = [];

    for (let i = 0; i < filteredMessagesRaw.length; i++) {
      if (skipIndices.has(i)) continue;
      const msg = filteredMessagesRaw[i];

      if (isSpawnTree(msg)) {
        const busId = msg.metadata!.busId as string;
        const group = groupsByBus.get(busId)!;
        const idsKey = group.ids.join(',');

        // Reuse cached merged message if IDs haven't changed (stable reference)
        const cached = prevMergedRef.current.get(busId);
        if (cached && (cached.metadata?.subAgentIds as string[])?.join(',') === idsKey) {
          result.push(cached);
          newMergedCache.set(busId, cached);
        } else {
          const merged = { ...msg, metadata: { ...msg.metadata, subAgentIds: group.ids } };
          result.push(merged);
          newMergedCache.set(busId, merged);
        }
      } else {
        result.push(msg);
      }
    }

    prevMergedRef.current = newMergedCache;
    return result;
  }, [filteredMessagesRaw]);

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTER HANDLER to receive realtime messages
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    // Always unregister previous handler when subAgentId changes
    const unregister = registerMessageHandler(subAgentId ?? null, (message: Message) => {
      // Messages arrive via realtime and are already added to context messages
      // The buffer is used to control animation timing, not to hold messages
      // Add to buffer - buffer processing will set currentAnimatingId to trigger animation
      setMessageBuffer((prev) => {
        // Prevent duplicates (shouldn't happen, but safety check)
        if (prev.some((m) => m.message_id === message.message_id)) {
          return prev;
        }
        return [...prev, message];
      });
    });

    // Mark initial load complete after first render
    // Existing messages from context won't go through buffer (they're already displayed)
    requestAnimationFrame(() => {
      isInitialLoadRef.current = false;
    });

    return () => {
      unregister();
    };
  }, [subAgentId, registerMessageHandler]);

  // ═══════════════════════════════════════════════════════════════════════════
  // BUFFER PROCESSING - pull one message at a time and animate
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    if (messageBuffer.length === 0 || isAnimating) return;

    const nextMessage = messageBuffer[0];

    // Remove from buffer (it's already in messages via context)
    setMessageBuffer((prev) => prev.slice(1));

    // Determine if should animate
    let shouldAnimate = false;

    // ASSISTANT messages animate unless already streamed
    if (nextMessage.role === 'ASSISTANT') {
      // Flag assistant INSERT for thinking dismissal
      assistantInsertedRef.current = true;

      const textKey = (nextMessage.text || '').trim();
      if (streamedTextsRef.current.has(textKey)) {
        console.log(`⏭️ [MessageList] Skipping animation for streamed text`);
        streamedTextsRef.current.delete(textKey);
        shouldAnimate = false;
      } else {
        shouldAnimate = true;
      }
    }

    // TOOL messages animate if FINISHED/ERROR with content
    if (nextMessage.role === 'TOOL') {
      const isAttention = !!nextMessage.metadata?.isUserAttentionMessage;
      const status = nextMessage.metadata?.toolStatus;
      const messageText = nextMessage.text || '';

      if (isAttention) {
        // Attention messages manage own animation
        shouldAnimate = false;
      } else if ((status === 'FINISHED' || status === 'ERROR') && messageText.trim().length > 0) {
        shouldAnimate = true;
      }
    }

    if (shouldAnimate) {
      setIsAnimating(true);
      setCurrentAnimatingId(nextMessage.message_id);
    }
  }, [messageBuffer, isAnimating]);

  // ═══════════════════════════════════════════════════════════════════════════
  // ANIMATION COMPLETE HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  const handleAnimationComplete = useCallback(() => {
    setIsAnimating(false);
    setCurrentAnimatingId(null);
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // FILTER STREAMING STATE for this subAgentId
  // ═══════════════════════════════════════════════════════════════════════════

  const filteredStreamingBubbles = useMemo(() => {
    const targetSubAgentId = subAgentId ?? null;
    return new Map(
      [...streamingBubbles].filter(
        ([_, bubble]) => (bubble.subAgentId ?? null) === targetSubAgentId,
      ),
    );
  }, [streamingBubbles, subAgentId]);

  const filteredStreamingPlan = useMemo(() => {
    if (!streamingPlan) return null;
    const targetSubAgentId = subAgentId ?? null;
    if ((streamingPlan.subAgentId ?? null) === targetSubAgentId) {
      return streamingPlan;
    }
    return null;
  }, [streamingPlan, subAgentId]);

  const filteredStreamingAttention = useMemo(() => {
    if (!streamingAttention) return null;
    const targetSubAgentId = subAgentId ?? null;
    if ((streamingAttention.subAgentId ?? null) === targetSubAgentId) {
      return streamingAttention;
    }
    return null;
  }, [streamingAttention, subAgentId]);

  const filteredStreamingTools = useMemo(() => {
    const targetSubAgentId = subAgentId ?? null;
    return new Map(
      [...streamingTools].filter(([_, tool]) => (tool.subAgentId ?? null) === targetSubAgentId),
    );
  }, [streamingTools, subAgentId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // THINKING CHAR COUNT + CLAUDE DETECTION - calculate from streaming bubbles
  // ═══════════════════════════════════════════════════════════════════════════

  const streamingCharCount = useMemo(() => {
    let totalChars = 0;
    filteredStreamingBubbles.forEach((bubble) => {
      totalChars += bubble.text.length;
    });
    return totalChars;
  }, [filteredStreamingBubbles]);

  // Default to false (blue). Switches to orange when any bubble has isClaude=true.
  const isClaudeStreaming = useMemo(() => {
    for (const [, bubble] of filteredStreamingBubbles) {
      if (bubble.isClaude) return true;
    }
    return false;
  }, [filteredStreamingBubbles]);

  const animatedCharCount = useAnimatedCounter(streamingCharCount, 0.3);

  // ═══════════════════════════════════════════════════════════════════════════
  // THINKING VISIBILITY state (with persistence)
  // ═══════════════════════════════════════════════════════════════════════════

  const [thinkingVisible, setThinkingVisible] = useState(false);
  const prevAgentIdRef = useRef<string | null | undefined>(selectedAgentId);
  const assistantInsertedRef = useRef(false);
  const showDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute whether thinking should show based on conditions
  const shouldShowThinking = useMemo(() => {
    if (!showThinkingIndicator) return false;

    // Condition 1: agent status is active
    const isAgentActive =
      agent &&
      agent.status !== 'PAUSED' &&
      agent.status !== 'COMPLETED' &&
      agent.status !== 'FAILED' &&
      agent.status !== 'OUT_OF_CREDITS' &&
      agent.status !== 'COST_LIMIT_REACHED';

    if (!isAgentActive) return false;

    // Always show if LLM is actively streaming (real-time thinking feedback)
    if (filteredStreamingBubbles.size > 0) return true;

    // Condition 2: no tools with status IN_PROGRESS (excluding isUserAttentionMessage)
    const hasInProgressTool = filteredMessages.some(
      (m) =>
        m.role === 'TOOL' &&
        m.metadata?.toolStatus === 'IN_PROGRESS' &&
        !m.metadata?.isUserAttentionMessage,
    );

    if (hasInProgressTool) return false;

    // Condition 3: check last message for send_message_to_user
    const lastMessage = filteredMessages[filteredMessages.length - 1];

    if (lastMessage?.metadata?.isUserAttentionMessage) {
      // In chat mode: NOT (last message is send_message_to_user at all)
      if (isChatMode) return false;

      // In agent mode: NOT (isQuestion == true OR toolApproval == true)
      const isQuestion = lastMessage.metadata?.sendMessageToUser?.isQuestion;
      const toolApproval = lastMessage.metadata?.requestUserApproval?.toolApproval;
      if (isQuestion === true || toolApproval === true) return false;
    }

    return true;
  }, [showThinkingIndicator, agent, filteredMessages, isChatMode, filteredStreamingBubbles.size]);

  // Effect to manage visibility with persistence rule + 500ms debounce for showing
  useEffect(() => {
    // Clear any pending debounce on cleanup or condition change
    if (showDebounceRef.current) {
      clearTimeout(showDebounceRef.current);
      showDebounceRef.current = null;
    }

    // Check for agent change - always sync to shouldShowThinking on agent change
    if (prevAgentIdRef.current !== selectedAgentId) {
      prevAgentIdRef.current = selectedAgentId;
      setThinkingVisible(shouldShowThinking);
      assistantInsertedRef.current = false;
      return;
    }

    // Always hide on ASSISTANT INSERT (dismissal trigger)
    if (assistantInsertedRef.current) {
      setThinkingVisible(false);
      assistantInsertedRef.current = false;
      return;
    }

    if (shouldShowThinking) {
      if (!thinkingVisible) {
        // Debounce showing by 800ms - only show if conditions still met after delay
        showDebounceRef.current = setTimeout(() => {
          setThinkingVisible(true);
        }, 800);
      }
      // If already visible, keep it visible (no change needed)
    }
    // Otherwise keep current state (persistence - don't hide until dismissal trigger)

    return () => {
      if (showDebounceRef.current) {
        clearTimeout(showDebounceRef.current);
        showDebounceRef.current = null;
      }
    };
  }, [shouldShowThinking, selectedAgentId, thinkingVisible]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND MESSAGE handler for attention messages
  // ═══════════════════════════════════════════════════════════════════════════

  const handleSendMessage = useCallback(
    async (text: string) => {
      try {
        await sendMessage(text);
      } catch (error) {
        console.error('Failed to send message:', error);
      }
    },
    [sendMessage],
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOSCROLL for streaming content (browser panel)
  // ═══════════════════════════════════════════════════════════════════════════

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when streaming content changes (for sub-agent panels)
  useLayoutEffect(() => {
    // Only auto-scroll for sub-agent panels (browser, code, etc.)
    if (subAgentId === undefined) return;

    // Auto-scroll when streaming bubbles have content
    if (filteredStreamingBubbles.size > 0 && scrollEndRef.current) {
      scrollEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [subAgentId, filteredStreamingBubbles]);

  // Also scroll when new messages arrive
  useLayoutEffect(() => {
    if (subAgentId === undefined) return;

    if (filteredMessages.length > 0 && scrollEndRef.current) {
      scrollEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [subAgentId, filteredMessages.length]);

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div ref={containerRef} className={containerClassName}>
      {/* Messages */}
      {filteredMessages.map((message) => (
        <MessageBubble
          key={message.message_id}
          message={message}
          shouldType={message.message_id === currentAnimatingId}
          onTypingComplete={handleAnimationComplete}
          onNavigateToAgent={onNavigateToAgent}
          agentId={selectedAgentId || undefined}
          onSendMessage={selectedAgentId ? handleSendMessage : undefined}
          compact={compact}
          onSubmitFeedback={onSubmitFeedback}
          exploreStepHistory={exploreStepMap.get(message.message_id)}
          waitForChecks={waitForCheckMap.get(message.message_id)}
          planCharCount={
            message.metadata?.toolName === 'set_plan' &&
            message.metadata?.toolStatus === 'IN_PROGRESS' &&
            filteredStreamingPlan?.char_count
              ? filteredStreamingPlan.char_count
              : undefined
          }
        />
      ))}

      {/* Chat Mode Actions - show copy + Start Agent when in chat mode after generator response */}
      {showStatusBanners &&
        subAgentId === undefined &&
        isChatMode &&
        (() => {
          const lastMessage = filteredMessages[filteredMessages.length - 1];
          // Only show after send_message_to_user (generator's final response), not intermediate tools like web_search
          const isChatComplete =
            lastMessage?.role === 'TOOL' &&
            lastMessage.metadata?.toolStatus === 'FINISHED' &&
            lastMessage.metadata?.toolName === 'send_message_to_user';
          const notStreaming =
            filteredStreamingBubbles.size === 0 && filteredStreamingTools.size === 0;
          const notAnimating = !isAnimating && messageBuffer.length === 0;

          if (isChatComplete && notStreaming && notAnimating && agent?.status === 'ACTIVE') {
            const handleCopy = async () => {
              // Copy the last assistant/tool response to clipboard
              const lastAssistant = [...filteredMessages]
                .reverse()
                .find(
                  (m) =>
                    m.role === 'ASSISTANT' ||
                    (m.role === 'TOOL' && m.metadata?.toolStatus === 'FINISHED' && m.text),
                );
              if (lastAssistant?.text) {
                await navigator.clipboard.writeText(lastAssistant.text);
                toast({ title: 'Copied to clipboard' });
              }
            };

            const handleStartAgent = async () => {
              if (!selectedAgentId) return;
              try {
                await startAgent(selectedAgentId);
                toast({ title: 'Agent mode started' });
              } catch (error) {
                toast({
                  title: 'Failed to start agent',
                  description: error instanceof Error ? error.message : 'Unknown error',
                  variant: 'destructive',
                });
              }
            };

            return (
              <div className="flex gap-3 animate-in fade-in duration-300">
                <div className="flex items-center gap-3 text-muted-foreground">
                  {/* Copy button */}
                  <button
                    onClick={handleCopy}
                    className="p-1.5 hover:bg-muted/50 rounded transition-colors"
                    title="Copy response"
                  >
                    <Copy className="w-4 h-4" />
                  </button>

                  {/* Separator */}
                  <div className="w-px h-4 bg-border" />

                  {/* Start Agent button */}
                  <button
                    onClick={handleStartAgent}
                    className="flex items-center gap-2 px-2 py-1 hover:bg-muted/50 rounded transition-colors text-sm"
                  >
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="1" />
                      <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
                      <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
                    </svg>
                    Start agent
                  </button>
                </div>
              </div>
            );
          }
          return null;
        })()}

      {/* Status Banners (only for main chat) */}
      {showStatusBanners && subAgentId === undefined && (
        <>
          {/* Paused banner */}
          {agent?.status === 'PAUSED' && (
            <div className="flex gap-3">
              <div
                className="flex items-center gap-2 py-1.5 px-3 rounded-full border border-border"
                style={{
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                }}
              >
                <div className="flex items-center justify-center w-5 h-5 rounded-full border-[1.5px] border-muted-foreground">
                  <svg
                    className="w-2 h-2 text-muted-foreground"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                </div>
                <span className="text-muted-foreground font-medium text-sm">
                  Rose has stopped, send a new message to continue
                </span>
              </div>
            </div>
          )}

          {/* Out of credits */}
          {agent?.status === 'OUT_OF_CREDITS' && (
            <div className="flex gap-3 items-center">
              <div className="flex items-center gap-3">
                <p className="text-sm text-red-500 dark:text-red-400 font-medium">
                  agent ran out of credits
                </p>
                {onAddCredits && (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={onAddCredits}
                    className="h-7 text-xs"
                  >
                    Add Credits
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Cost limit reached */}
          {agent?.status === 'COST_LIMIT_REACHED' && (
            <div className="flex gap-3 items-center">
              <div className="flex items-center gap-3">
                <p className="text-sm text-amber-500 dark:text-amber-400 font-medium">
                  agent cost limit reached
                </p>
                {onIncreaseCostLimit && (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={onIncreaseCostLimit}
                    className="h-7 text-xs"
                  >
                    Increase Cost Limit
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Completed - FeedbackBanner is now rendered below CompletionSummaryCard in MessageBubble */}
        </>
      )}

      {/* Thinking indicator with token counter */}
      {thinkingVisible && (
        <div className={cn('flex', !compact && 'gap-3')}>
          <div className="flex flex-col gap-2">
            {/* Thinking header with token counter */}
            <div className="flex items-center gap-2">
              <ThinkingAnimation
                dataUrl="./thinking_animations.txt"
                autoplay
                loop
                className="w-4 h-4 flex-shrink-0"
                style={{ width: '16px', height: '16px' }}
                gradient={isClaudeStreaming ? CLAUDE_GRADIENT : undefined}
              />
              <span className="text-sm font-medium animate-shimmer bg-gradient-to-r bg-[length:200%_100%] bg-clip-text text-transparent from-foreground via-muted-foreground to-foreground">
                Thinking
              </span>
              {/* Char counter */}
              {streamingCharCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                  <ArrowDown className="w-3 h-3" />
                  <span className="tabular-nums">{animatedCharCount.toLocaleString()}</span>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Streaming tools - early detection indicators (below thinking bubble) */}
      {Array.from(filteredStreamingTools.values()).map((tool) => (
        <MessageBubble
          key={`streaming-tool-${tool.tool_call_id}`}
          message={{
            message_id: `streaming-${tool.tool_call_id}`,
            role: 'TOOL',
            text: '',
            timestamp: new Date().toISOString(),
            metadata: {
              toolCallId: tool.tool_call_id,
              toolName: tool.tool_name,
              toolStatus: 'IN_PROGRESS',
              title: tool.title,
            },
          }}
          shouldType={false}
          onTypingComplete={() => {}}
          compact={compact}
        />
      ))}

      {/* Streaming attention message */}
      {filteredStreamingAttention &&
        subAgentId === undefined &&
        filteredStreamingBubbles.size > 0 && (
          <div className="flex gap-3 mt-4">
            <MessageBubble
              key={`streaming-attention-${filteredStreamingAttention.tool_call_id}`}
              message={{
                message_id: `streaming-${filteredStreamingAttention.tool_call_id}`,
                role: 'TOOL',
                text: filteredStreamingAttention.message,
                timestamp: new Date().toISOString(),
                metadata: {
                  toolCallId: filteredStreamingAttention.tool_call_id,
                  toolName: 'send_message_to_user',
                  toolStatus: 'IN_PROGRESS',
                  isUserAttentionMessage: true,
                  attentionMessage: filteredStreamingAttention.message,
                },
              }}
              shouldType={false}
              onTypingComplete={() => {}}
              onSendMessage={handleSendMessage}
              isStreaming={true}
            />
          </div>
        )}

      {/* Preview Mode banner for web-spawned agents - always below all other items */}
      {showStatusBanners && subAgentId === undefined && agent?.source === 'WEB' && (
        <div className="flex gap-3">
          <div
            className="flex items-center gap-2 py-1.5 px-3 rounded-full border border-border"
            style={{
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
            }}
          >
            <span className="text-muted-foreground text-sm">
              Agents spawned via web are in Preview Mode and have restricted functionality. To
              enable all tools
            </span>
            <a
              href="/download"
              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-foreground text-background hover:opacity-90 transition-opacity"
            >
              Download for Mac
            </a>
          </div>
        </div>
      )}

      {/* Scroll anchor for auto-scroll */}
      <div ref={scrollEndRef} />
    </div>
  );
}

export default MessageList;
