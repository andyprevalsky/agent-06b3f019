import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useAgentContext, StreamingBubble } from '@/contexts/AgentContext';
import { Message, startAgent } from '@/lib/api';
import MessageBubble from './MessageBubble';
import { PlanChip } from './PlanChip';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { Button } from '@/components/ui/button';
import { FeedbackBanner, FeedbackData } from './FeedbackBanner';
import { Copy } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

// ═══════════════════════════════════════════════════════════════════════════════
// StreamingMarkdown - Renders text with fade-in animation for each chunk
// ═══════════════════════════════════════════════════════════════════════════════

function StreamingMarkdown({ text }: { text: string }) {
  const prevTextRef = useRef('');
  const [chunks, setChunks] = useState<string[]>([]);
  
  useEffect(() => {
    if (text.length > prevTextRef.current.length) {
      const delta = text.slice(prevTextRef.current.length);
      setChunks(prev => [...prev, delta]);
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

function deduplicateToolMessages(messages: Message[]): Message[] {
  const sortedMessages = [...messages].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Find timestamp of last ASSISTANT message - used to clean up orphaned IN_PROGRESS tools
  const lastAssistantTimestamp = sortedMessages
    .filter(m => m.role === 'ASSISTANT')
    .map(m => new Date(m.timestamp).getTime())
    .pop() ?? 0;

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
        toolMessageMap.set(toolCallId, {
          message: isAttention
            ? { ...message, message_id: existing.message.message_id }
            : message,
          firstTimestamp: existing.firstTimestamp
        });
      } else {
        toolMessageMap.set(toolCallId, {
          message: message,
          firstTimestamp: message.timestamp
        });
      }
    } else {
      nonToolMessages.push(message);
    }
  });

  const deduplicatedToolMessages = Array.from(toolMessageMap.values()).map(({ message, firstTimestamp }) => ({
    ...message,
    timestamp: firstTimestamp
  }));

  // Clean up orphaned IN_PROGRESS tools from failed LLM calls
  // If an ASSISTANT message came AFTER an IN_PROGRESS tool, that tool is orphaned
  const cleanedToolMessages = deduplicatedToolMessages.filter(m => {
    // Keep all FINISHED/ERROR tools
    if (m.metadata?.toolStatus !== 'IN_PROGRESS') return true;
    
    // Keep user attention IN_PROGRESS (different lifecycle - waiting for user)
    if (m.metadata?.isUserAttentionMessage) return true;
    
    // For other IN_PROGRESS, only keep if it came after the last ASSISTANT message
    const toolTime = new Date(m.timestamp).getTime();
    return toolTime >= lastAssistantTimestamp;
  });

  // Compress set_plan messages - only keep the latest one
  const latestSetPlan = cleanedToolMessages
    .filter(m => m.metadata?.toolName === 'set_plan')
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  
  const withCompressedPlans = cleanedToolMessages.filter(m => 
    m.metadata?.toolName !== 'set_plan' || m.message_id === latestSetPlan?.message_id
  );

  const deduplicatedMessages = [...nonToolMessages, ...withCompressedPlans];
  deduplicatedMessages.sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return deduplicatedMessages;
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
  containerClassName = "max-w-4xl mx-auto flex flex-col gap-1.5 pb-32 relative z-20",
  showStatusBanners = true,
  showThinkingIndicator = true,
  compact = false,
  onAddCredits,
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
  
  const filteredMessages = useMemo(() => {
    const targetSubAgentId = subAgentId ?? null;
    
    // Filter messages for this subAgentId
    const filtered = messages.filter(m => {
      const msgSubAgentId = m.metadata?.subAgentId ?? null;
      // Main chat (null) shows messages without subAgentId
      // Sub-agent shows only messages with matching subAgentId
      if (targetSubAgentId === null) {
        return msgSubAgentId === null;
      }
      return msgSubAgentId === targetSubAgentId;
    });
    
    // Filter out SYSTEM messages
    const withoutSystem = filtered.filter(m => m.role !== 'SYSTEM');
    
    // Deduplicate tool messages
    return deduplicateToolMessages(withoutSystem);
  }, [messages, subAgentId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTER HANDLER to receive realtime messages
  // ═══════════════════════════════════════════════════════════════════════════
  
  useEffect(() => {
    // Always unregister previous handler when subAgentId changes
    const unregister = registerMessageHandler(
      subAgentId ?? null,
      (message: Message) => {
        // Messages arrive via realtime and are already added to context messages
        // The buffer is used to control animation timing, not to hold messages
        // Add to buffer - buffer processing will set currentAnimatingId to trigger animation
        setMessageBuffer(prev => {
          // Prevent duplicates (shouldn't happen, but safety check)
          if (prev.some(m => m.message_id === message.message_id)) {
            return prev;
          }
          return [...prev, message];
        });
      }
    );
    
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
    setMessageBuffer(prev => prev.slice(1));
    
    // Determine if should animate
    let shouldAnimate = false;
    
    // ASSISTANT messages animate unless already streamed
    if (nextMessage.role === 'ASSISTANT') {
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
      [...streamingBubbles].filter(([_, bubble]) => 
        (bubble.subAgentId ?? null) === targetSubAgentId
      )
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
      [...streamingTools].filter(([_, tool]) => 
        (tool.subAgentId ?? null) === targetSubAgentId
      )
    );
  }, [streamingTools, subAgentId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // THINKING LOADER state
  // ═══════════════════════════════════════════════════════════════════════════
  
  const [showThinkingLoader, setShowThinkingLoader] = useState(false);
  
  useEffect(() => {
    if (!showThinkingIndicator) {
      setShowThinkingLoader(false);
      return;
    }
    
    if (!agent || 
        agent.status === 'COMPLETED' || 
        agent.status === 'FAILED' || 
        agent.status === 'PAUSED' ||
        agent.status === 'OUT_OF_CREDITS' ||
        messageBuffer.length > 0 ||
        isAnimating) {
      setShowThinkingLoader(false);
      return;
    }

    const lastMessage = filteredMessages[filteredMessages.length - 1];
    if (!lastMessage) {
      setShowThinkingLoader(false);
      return;
    }

    if (lastMessage.role === 'TOOL') {
      const status = lastMessage.metadata?.toolStatus;
      if (status === 'IN_PROGRESS') {
        setShowThinkingLoader(false);
        return;
      }
    }

    let lastSeenTime = Date.now();
    const checkThreshold = () => {
      const timeSince = Date.now() - lastSeenTime;
      setShowThinkingLoader(timeSince > 500);
    };

    checkThreshold();
    const interval = setInterval(checkThreshold, 100);
    return () => clearInterval(interval);
  }, [filteredMessages.length, agent?.status, isAnimating, messageBuffer.length, showThinkingIndicator]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND MESSAGE handler for attention messages
  // ═══════════════════════════════════════════════════════════════════════════
  
  const handleSendMessage = useCallback(async (text: string) => {
    try {
      await sendMessage(text);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, [sendMessage]);

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
        />
      ))}

      {/* Chat Mode Actions - show copy + Start Agent when in chat mode after tool response */}
      {showStatusBanners && subAgentId === undefined && isChatMode && (() => {
        const lastMessage = filteredMessages[filteredMessages.length - 1];
        const isToolFinished = lastMessage?.role === 'TOOL' &&
          lastMessage.metadata?.toolStatus === 'FINISHED';
        const notStreaming = filteredStreamingBubbles.size === 0 && filteredStreamingTools.size === 0;
        const notAnimating = !isAnimating && messageBuffer.length === 0;

        if (isToolFinished && notStreaming && notAnimating && agent?.status === 'ACTIVE') {
          const handleCopy = async () => {
            // Copy the last assistant/tool response to clipboard
            const lastAssistant = [...filteredMessages].reverse().find(m =>
              m.role === 'ASSISTANT' || (m.role === 'TOOL' && m.metadata?.toolStatus === 'FINISHED' && m.text)
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
                variant: 'destructive'
              });
            }
          };

          return (
            <div className="flex gap-3 animate-in fade-in duration-300">
              <div className="flex-shrink-0 w-8 hidden md:block" />
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
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              <div className="flex-shrink-0 w-8 hidden md:block" />
              <div 
                className="flex items-center gap-2 py-1.5 px-3 rounded-full border border-border"
                style={{
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                }}
              >
                <div className="flex items-center justify-center w-5 h-5 rounded-full border-[1.5px] border-muted-foreground">
                  <svg className="w-2 h-2 text-muted-foreground" fill="currentColor" viewBox="0 0 24 24">
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
              <div className="flex-shrink-0 w-8 hidden md:block" />
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
          
          {/* Completed - with Feedback Banner */}
          {agent?.status === 'COMPLETED' && onSubmitFeedback && (
            <FeedbackBanner onSubmit={onSubmitFeedback} />
          )}
          {agent?.status === 'COMPLETED' && !onSubmitFeedback && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 hidden md:block" />
              <p className="text-sm text-muted-foreground">your goal is complete</p>
            </div>
          )}
        </>
      )}
      
      {/* Thinking indicator with streaming */}
      {showThinkingIndicator && (
        // Show if:
        // 1. We have active streaming bubbles, OR
        // 2. showThinkingLoader is true AND the last message is NOT an ASSISTANT (we're waiting for response)
        // This prevents the flash when INSERT arrives before showThinkingLoader is updated
        // In chat mode, don't show thinking indicator when last message is a finished tool (chat is waiting for user)
        (filteredStreamingBubbles.size > 0 ||
         (showThinkingLoader && filteredMessages[filteredMessages.length - 1]?.role !== 'ASSISTANT')) &&
        agent?.status !== 'PAUSED' &&
        // Hide thinking in chat mode when last message is finished tool (waiting for user input)
        !(isChatMode && filteredMessages[filteredMessages.length - 1]?.role === 'TOOL' &&
          filteredMessages[filteredMessages.length - 1]?.metadata?.toolStatus === 'FINISHED') && (
          <div className={cn("flex", !compact && "gap-3")}>
            {!compact && <div className="flex-shrink-0 w-8 hidden md:block" />}
            <div className="flex flex-col gap-2">
              {/* Thinking header */}
              <div className="flex items-center gap-2">
                <ThinkingAnimation
                  dataUrl="./thinking_animations.txt"
                  autoplay
                  loop
                  className="w-4 h-4 flex-shrink-0"
                  style={{ width: '16px', height: '16px' }}
                />
                <span className="text-sm font-medium animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent">
                  Thinking
                </span>
              </div>
              
              {/* Streaming text with max-height and auto-scroll */}
              {filteredStreamingBubbles.size > 0 && (
                <div className="pl-6 max-h-[200px] overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
                  {Array.from(filteredStreamingBubbles.entries()).map(([streamId, bubble]) => (
                    <StreamingMarkdown key={streamId} text={bubble.text} />
                  ))}
                </div>
              )}
              
              {/* Streaming plan */}
              {filteredStreamingPlan && (
                <div className="pl-6 mt-2">
                  <PlanChip
                    plan={{
                      title: filteredStreamingPlan.title,
                      content: '',
                      tasks: [],
                      dependencies: null,
                      join: 'all',
                      status: 'planning',
                    }}
                    toolStatus="IN_PROGRESS"
                  />
                </div>
              )}
            </div>
          </div>
        )
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
      {filteredStreamingAttention && subAgentId === undefined && filteredStreamingBubbles.size > 0 && (
        <div className="flex gap-3 mt-4">
          <div className="flex-shrink-0 w-8 hidden md:block" />
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
      
      {/* Scroll anchor for auto-scroll */}
      <div ref={scrollEndRef} />
    </div>
  );
}

export default MessageList;

