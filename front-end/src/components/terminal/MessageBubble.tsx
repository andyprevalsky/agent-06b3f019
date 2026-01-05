import { Message, respondToAttentionRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Bot, User, Wrench, Info, ChevronRight } from 'lucide-react';
import { useState, useEffect, useMemo, memo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import SubAgentToolBubble from './SubAgentToolBubble';
import SignupPromptBubble from './SignupPromptBubble';
import SubAgentTree from './SubAgentTree';
import { MarkdownText } from './MarkdownText';
import { PlanChip } from './PlanChip';
import { getToolIcon, isX402Tool, x402IconSrc } from '@/lib/toolIcons';
import { useToast } from '@/hooks/use-toast';
import ThinkingAnimation from '../ThinkingAnimation';

interface MessageBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  /** Indicates this is a streaming bubble (in-progress LLM response) */
  isStreaming?: boolean;
  /** Agent ID for sending messages */
  agentId?: string;
  /** Callback to send a message */
  onSendMessage?: (message: string) => void;
  /** Compact mode - removes left spacers for tighter layouts */
  compact?: boolean;
  /** Callback to open the auth modal (for signup prompts) */
  onOpenAuthModal?: () => void;
}

interface ToolMessageData {
  toolCallId: string;
  toolName?: string;
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  message: string;
  error?: boolean;
  progressComplete?: number; // 0-100 or 0-1, optional - if present shows progress bar
  actionMetadata?: Record<string, any> | null;
  // Auto-simulation countdown
  timeout?: number; // Duration in seconds (e.g., 60)
  startTime?: string; // ISO timestamp when timer started
  simulated?: boolean; // True if response was auto-generated
  // Browser action type (for icon selection)
  actionType?: string;
}

// Extract emoji from start of text and return {emoji, text}
function extractEmoji(text: string): { emoji: string; text: string } {
  // Comprehensive emoji regex including variant selectors and ZWJ sequences
  const emojiRegex = /^([\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+)\s*/gu;
  const match = text.match(emojiRegex);
  
  if (match) {
    const emoji = match[0];
    const remainingText = text.slice(emoji.length).trim();
    return { emoji, text: remainingText };
  }
  
  return { emoji: '', text };
}

const roleConfig = {
  SYSTEM: {
    icon: Info,
    bg: 'bg-blue-500/10 dark:bg-blue-500/20',
    border: 'border-blue-500/30',
    text: 'text-blue-700 dark:text-blue-300',
    label: 'System',
  },
  ASSISTANT: {
    icon: Bot,
    bg: 'bg-purple-500/10 dark:bg-purple-500/20',
    border: 'border-purple-500/30',
    text: 'text-purple-700 dark:text-purple-300',
    label: 'Agent',
  },
  USER: {
    icon: User,
    bg: 'bg-primary/10 dark:bg-primary/20',
    border: 'border-primary/30',
    text: 'text-foreground',
    label: 'You',
  },
  TOOL: {
    icon: Wrench,
    bg: 'bg-muted/50',
    border: 'border-border',
    text: 'text-muted-foreground',
    label: 'Tool',
  },
};

const ToolMessage = memo(function ToolMessage({ 
  data, 
  shouldType = false, 
  onComplete 
}: { 
  data: ToolMessageData; 
  shouldType?: boolean;
  onComplete?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasAnimated, setHasAnimated] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const { toast } = useToast();
  const actionMetadata = data.actionMetadata;
  
  // Countdown timer effect for auto-simulation
  useEffect(() => {
    // Only show countdown for IN_PROGRESS attention requests with timeout
    if (data.status !== 'IN_PROGRESS' || !data.timeout || !data.startTime) {
      setCountdownSeconds(null);
      return;
    }
    
    const calculateRemaining = () => {
      const startTime = new Date(data.startTime!).getTime();
      const now = Date.now();
      const elapsed = (now - startTime) / 1000;
      const remaining = Math.max(0, data.timeout! - elapsed);
      return Math.ceil(remaining);
    };
    
    // Initial calculation
    setCountdownSeconds(calculateRemaining());
    
    // Update every second
    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setCountdownSeconds(remaining);
      
      // Stop interval when timer reaches 0
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);
    
    return () => clearInterval(interval);
  }, [data.status, data.timeout, data.startTime]);
  
  // Get tool icon - prefer actionType for browser actions, fall back to toolName
  const ToolIcon = data.actionType 
    ? getToolIcon(data.actionType) 
    : (data.toolName ? getToolIcon(data.toolName) : Wrench);
  const isThought = data.toolName === 'thought';
  const [forceExpanded, setForceExpanded] = useState(
    isThought && data.status === 'IN_PROGRESS'
  );
  useEffect(() => {
    if (!isThought) return;
    if (data.status === 'IN_PROGRESS') {
      setForceExpanded(true);
      setIsExpanded(true);
    } else {
      setForceExpanded(false);
      setIsExpanded(false);
    }
  }, [isThought, data.status]);
  
  // Extract emoji from title (memoized) - keeping for backward compatibility
  const { emoji, text: titleText } = useMemo(() => extractEmoji(data.title), [data.title]);
  
  // Memoize computed values
  const hasMessage = useMemo(() => data.message.trim().length > 0, [data.message]);
  // FINISHED and ERROR statuses should both be expandable (not IN_PROGRESS)
  const isExpandable = useMemo(
    () => data.status === 'FINISHED' || data.status === 'ERROR',
    [data.status]
  );
  const showChevron = useMemo(
    () => hasMessage && isExpandable && !forceExpanded,
    [hasMessage, isExpandable, forceExpanded]
  );
  const shouldBeExpanded = useMemo(
    () => forceExpanded || (shouldType && !hasAnimated) || isExpanded,
    [forceExpanded, shouldType, hasAnimated, isExpanded]
  );

  // Handle animation completion - collapse after animating
  const handleAnimationComplete = () => {
    console.log(`[${performance.now().toFixed(2)}] 🔽 COLLAPSE: Tool message collapsing`);
    setHasAnimated(true);
    if (!forceExpanded) {
      setIsExpanded(false); // Collapse after animation (will reopen on click)
    }
    
    // Use requestAnimationFrame to ensure DOM updates before unlocking queue
    if (onComplete) {
      requestAnimationFrame(() => {
        onComplete();
      });
    }
  };

  // Calculate progress percentage (handle both 0-1 and 0-100 ranges)
  const progressPercent = useMemo(() => {
    if (data.progressComplete === undefined) return undefined;
    // If value is <= 1, assume it's 0-1 range, convert to 0-100
    return data.progressComplete <= 1 ? data.progressComplete * 100 : data.progressComplete;
  }, [data.progressComplete]);

  const showProgressBar =
    !isThought && progressPercent !== undefined && data.status === 'IN_PROGRESS';

  const handleAction = async () => {
    if (!actionMetadata) return;
    if (actionMetadata.onSuccess !== 'sendSmsThroughIMessage') return;
    if (!actionMetadata.attentionRequestId) {
      toast({
        title: 'Missing request reference',
        description: 'Open the attention inbox to retry.',
        variant: 'destructive',
      });
      return;
    }

    const bridge = (typeof window !== 'undefined' ? (window as any).api : undefined);
    if (!bridge?.sendIMessage) {
      toast({
        title: 'Mac app required',
        description: 'Open the Rose Mac app to send this message automatically.',
        variant: 'destructive',
      });
      return;
    }

    const to = actionMetadata.to;
    const message = actionMetadata.message;

    if (!to || !message) {
      toast({
        title: 'Missing details',
        description: 'Recipient or message is missing from this request.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setActionLoading(true);
      const result = await bridge.sendIMessage({ to, message });
      if (result && result.success === false) {
        throw new Error(result.message || 'iMessage send failed');
      }
      await respondToAttentionRequest(actionMetadata.attentionRequestId, 'Message sent via Mac app ✅');
      toast({
        title: 'iMessage sent',
        description: 'Approval recorded. Check the attention inbox for updates.',
      });
    } catch (error) {
      console.error('Failed to send via iMessage from message bubble:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send via iMessage',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Title row */}
      <div 
        className={cn(
          "flex items-center gap-2",
          hasMessage && isExpandable && "cursor-pointer hover:opacity-80 transition-opacity"
        )}
        onClick={hasMessage && isExpandable ? () => setIsExpanded(!isExpanded) : undefined}
      >
        {/* Tool Icon */}
        {isThought ? (
          data.status === 'IN_PROGRESS' ? (
            <ThinkingAnimation
              dataUrl="./thinking_animations.txt"
              autoplay
              loop
              className="w-4 h-4 flex-shrink-0"
              style={{ width: '16px', height: '16px' }}
            />
          ) : (
            <div className="h-4 w-4 flex-shrink-0" />
          )
        ) : data.toolName && isX402Tool(data.toolName) ? (
          <img 
            src={x402IconSrc} 
            alt="x402" 
            className="h-4 w-4 flex-shrink-0 opacity-60 dark:invert dark:opacity-70" 
          />
        ) : (
          <ToolIcon className={cn(
            "h-4 w-4 flex-shrink-0",
            data.error && "text-red-600 dark:text-red-400",
            !data.error && data.status === 'IN_PROGRESS' && "text-muted-foreground",
            !data.error && data.status === 'FINISHED' && "text-muted-foreground"
          )} />
        )}
        
        {/* Text / status */}
        <span 
          className={cn(
            "text-sm font-medium",
            isThought && data.status === 'IN_PROGRESS' && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
            isThought && data.status !== 'IN_PROGRESS' && "text-foreground",
            !isThought && data.error && "text-red-600 dark:text-red-400",
            !isThought && !data.error && data.status === 'IN_PROGRESS' && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
            !isThought && !data.error && data.status === 'FINISHED' && "text-foreground"
          )}
        >
          {isThought ? (data.status === 'IN_PROGRESS' ? 'Thinking' : 'Thought') : titleText}
        </span>

        {showChevron && (
          <ChevronRight 
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-75",
              shouldBeExpanded && "rotate-90"
            )} 
          />
        )}
      </div>

      {/* Progress bar - shown when progressComplete exists and status is IN_PROGRESS */}
      {showProgressBar && (
        <div className="w-[180px] h-[4px] bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
          />
        </div>
      )}

      {/* Countdown timer for auto-simulation */}
      {countdownSeconds !== null && countdownSeconds > 0 && data.status === 'IN_PROGRESS' && (
        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
          Auto-answering in {countdownSeconds}s
        </span>
      )}

      {/* Simulated response indicator */}
      {data.simulated && data.status === 'FINISHED' && (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          (Auto-answered)
        </span>
      )}

      {actionMetadata?.onSuccess === 'sendSmsThroughIMessage' && (
        <div className="rounded-md border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Send this via your Mac to unblock the agent.
          </p>
          <div className="text-xs text-muted-foreground space-y-1">
            {actionMetadata.to && (
              <p><span className="font-semibold">To:</span> {actionMetadata.to}</p>
            )}
            {actionMetadata.message && (
              <p className="whitespace-pre-wrap break-words">
                <span className="font-semibold">Message:</span> {actionMetadata.message}
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleAction}
            disabled={actionLoading}
          >
            {actionLoading ? 'Sending...' : 'Send via Mac iMessage'}
          </Button>
        </div>
      )}

      {/* Expandable message content with max-height and scroll */}
      {hasMessage && shouldBeExpanded && (
        <div className="overflow-hidden transition-all duration-200">
          <div className="pr-2 pl-4 border-l-2 border-border max-h-[300px] overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
            <MarkdownText
              text={data.message}
              shouldAnimate={(shouldType && !hasAnimated) || forceExpanded}
              onComplete={handleAnimationComplete}
              className="text-sm text-muted-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
});

// StreamingText - renders text with fade-in animation for each chunk (for streaming attention)
function StreamingText({ text }: { text: string }) {
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
    <span className="text-sm">
      {chunks.map((chunk, i) => (
        <span
          key={i}
          className="animate-in fade-in duration-300"
        >
          {chunk}
        </span>
      ))}
    </span>
  );
}

// AttentionMessage - renders send_message_to_user as raw text with animation tracking
const AttentionMessage = memo(function AttentionMessage({
  attentionMessage,
  isWaiting,
  shouldType = false,
  onComplete,
  onStartExecution,
  isStreaming = false,
}: {
  attentionMessage: string;
  isWaiting: boolean;
  shouldType?: boolean;
  onComplete?: () => void;
  onStartExecution?: () => void;
  isStreaming?: boolean;
}) {
  const [hasAnimated, setHasAnimated] = useState(false);
  
  const handleAnimationComplete = () => {
    setHasAnimated(true);
    if (onComplete) {
      requestAnimationFrame(() => {
        onComplete();
      });
    }
  };
  
  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-shrink-0 w-8 hidden md:block" />

      <div className="flex-1 space-y-3">
        {/* Render message as raw markdown text */}
        <div className="text-sm">
          {isStreaming ? (
            <StreamingText text={attentionMessage} />
          ) : (
            <MarkdownText 
              text={attentionMessage}
              shouldAnimate={isWaiting && !hasAnimated}
              onComplete={handleAnimationComplete}
            />
          )}
        </div>
        
        {/* Yellow dashed circle indicator - only show while waiting */}
        {isWaiting && !isStreaming && (
          <>
            <div className="flex items-center gap-2 text-amber-500">
              <div 
                className="w-4 h-4 rounded-full border-2 border-dashed border-amber-500" 
                style={{ animation: 'spin 3s linear infinite' }} 
              />
              <span className="text-xs font-medium">
                Your Rose agent will continue working after your reply
              </span>
            </div>
            
            {/* Start Autonomous Execution button */}
            {onStartExecution && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onStartExecution}
                      className="flex items-center gap-2 text-muted-foreground hover:bg-muted/30 hover:text-muted-foreground"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="1" />
                        <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
                        <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
                      </svg>
                      Start Autonomous Execution
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-left text-xs">
                    <p>Once Rose enters <strong>Autonomous Execution</strong> mode they will not ask you any more questions and will relentlessly explore all possible avenues in order to accomplish your goal given the context at its disposal.</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </>
        )}
      </div>
    </div>
  );
});

export default function MessageBubble({ message, shouldType = false, onTypingComplete, onNavigateToAgent, isStreaming = false, agentId, onSendMessage, compact = false, onOpenAuthModal }: MessageBubbleProps) {
  const config = roleConfig[message.role];
  const Icon = config.icon;
  const isUser = message.role === 'USER';
  const isTool = message.role === 'TOOL';
  const isAssistant = message.role === 'ASSISTANT';
  const isSystem = message.role === 'SYSTEM';

  // Check if this is a send_message_to_user message (render as raw text, not tool card)
  const isUserAttentionMessage = isTool && message.metadata?.isUserAttentionMessage;

  // Check if this is a request_user_signup message (render as SignupPromptBubble)
  const isSignupRequest = isTool && message.metadata?.requestUserSignup;

  // Check if this is a sub-agent tool message (actual spawn_sub_agents calls, not browser actions)
  const isSubAgentTool = message.metadata?.toolName === 'spawn_sub_agents';

  // Check if this is a set_plan tool message (render as PlanChip)
  const isSetPlanTool = isTool && message.metadata?.toolName === 'set_plan';

  // Memoize tool data to prevent flickers on re-renders
  const toolData = useMemo(() => {
    // Streaming messages should NOT render as "Thought" tool cards
    // They use the direct text rendering at the bottom of the component
    if (isStreaming) {
      return null;
    }
    
    if (isAssistant) {
      const assistantStatus: ToolMessageData['status'] = shouldType ? 'IN_PROGRESS' : 'FINISHED';
      return {
        toolCallId: message.message_id,
        toolName: 'thought',
        title: assistantStatus === 'IN_PROGRESS' ? 'Thinking' : 'Thought',
        status: assistantStatus,
        message: message.text,
      } as ToolMessageData;
    }

    if (!isTool || !message.metadata) return null;
    
    // Extract sendMessageToUser sub-metadata if present (fallback to legacy requestUserAttention)
    const attentionMeta = message.metadata.sendMessageToUser || message.metadata.requestUserAttention || {};
    
    const toolStatus = message.metadata.toolStatus === 'ERROR'
      ? 'FINISHED'
      : (message.metadata.toolStatus || 'FINISHED');

    return {
      toolCallId: message.metadata.toolCallId || '',
      toolName: message.metadata.toolName || '',
      title: message.metadata.title || 'Tool',
      status: toolStatus,
      message: message.text,
      error: message.metadata.error || false,
      progressComplete: message.metadata.progressComplete,
      actionMetadata: message.metadata.sendMessageToUser || message.metadata.requestUserAttention,
      // Auto-simulation countdown fields - these are on the root metadata, not inside requestUserAttention
      timeout: message.metadata.timeout || attentionMeta.timeout,
      startTime: message.metadata.startTime || attentionMeta.startTime,
      simulated: message.metadata.simulated || attentionMeta.simulated,
      // Browser action type for icon selection
      actionType: message.metadata.action_type,
    } as ToolMessageData;
  }, [isAssistant, shouldType, isTool, message, isStreaming]);

  // Sub-agent tool messages: use SubAgentTree for summary messages with subAgentIds/busId,
  // or SubAgentToolBubble for individual progress updates
  const subAgentBubble = useMemo(() => {
    if (!isSubAgentTool || !message.metadata) return null;

    const toolStatus = message.metadata.toolStatus === 'ERROR'
      ? 'FINISHED'
      : (message.metadata.toolStatus || 'FINISHED');

    // Check if this is a summary message with tree data (has subAgentIds and busId)
    const subAgentIds = message.metadata.subAgentIds as string[] | undefined;
    const busId = message.metadata.busId as string | undefined;

    if (subAgentIds && subAgentIds.length > 0 && busId) {
      // Render tree view for summary messages
      // Strip emoji prefix from title if present, use "Spawning agent cluster" as default
      let title = (message.metadata.title as string) || 'Spawning agent cluster';
      // Remove leading emoji (star, rocket, etc.)
      title = title.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/u, '');
      return (
        <div className="flex gap-3 animate-in fade-in duration-300">
          <div className="flex-shrink-0 w-8" />
          <SubAgentTree
            busId={busId}
            subAgentIds={subAgentIds}
            title={title}
            onNavigate={(agentId) => {
              if (onNavigateToAgent) {
                onNavigateToAgent(agentId);
              }
            }}
          />
        </div>
      );
    }

    // Check if this is the initial "Spawning X sub-agents" message (IN_PROGRESS, no subAgentId)
    const isSpawningMessage = toolStatus === 'IN_PROGRESS' && !message.metadata.subAgentId;
    if (isSpawningMessage) {
      // Render simple text line matching tree node style with └─ prefix
      return (
        <div className="flex gap-3 animate-in fade-in duration-300">
          <div className="flex-shrink-0 w-8" />
          <div className="flex items-center gap-1 font-mono text-sm">
            <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">└─</span>
            <span className="w-4 text-center select-none animate-pulse">○</span>
            <span className="text-gray-700 dark:text-gray-300">
              Spawning sub-agents...
            </span>
          </div>
        </div>
      );
    }

    // Render chip for individual progress updates (has subAgentId but not subAgentIds)
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        {/* Empty space where icon would be to align with agent messages */}
        <div className="flex-shrink-0 w-8 hidden md:block" />

        <div className="flex-1">
          <SubAgentToolBubble
            toolCallId={message.metadata.toolCallId || ''}
            title={message.metadata.title || 'Sub-agent'}
            message={message.text}
            status={toolStatus}
            progress={message.metadata.progress || 0}
            agentId={message.metadata.subAgentId}
            onNavigate={(agentId) => {
              if (onNavigateToAgent) {
                onNavigateToAgent(agentId);
              }
            }}
          />
        </div>
      </div>
    );
  }, [isSubAgentTool, message.metadata, message.text, onNavigateToAgent]);

  if (subAgentBubble) return subAgentBubble;

  // request_user_signup: render as SignupPromptBubble
  if (isSignupRequest && agentId) {
    const signupReason = message.metadata?.requestUserSignup?.reason || message.text || 'Please sign up to continue.';
    const isWaiting = message.metadata?.toolStatus === 'IN_PROGRESS';

    return (
      <SignupPromptBubble
        reason={signupReason}
        agentId={agentId}
        isWaiting={isWaiting}
        shouldType={shouldType}
        onComplete={onTypingComplete}
        onOpenAuthModal={onOpenAuthModal}
      />
    );
  }

  // set_plan tool: render as PlanChip instead of standard tool card
  // NOTE: Must call onTypingComplete immediately since PlanChip doesn't animate text.
  // The message queue in Terminal.tsx blocks on isAnimating until callback is called.
  // IN_PROGRESS messages show shimmer effect, FINISHED shows final state.
  if (isSetPlanTool) {
    const toolStatus = message.metadata?.toolStatus as 'IN_PROGRESS' | 'FINISHED' | undefined;
    const planData = message.metadata?.data;
    
    // Only call onTypingComplete for FINISHED status
    if (toolStatus === 'FINISHED' && shouldType && onTypingComplete) {
      requestAnimationFrame(() => {
        onTypingComplete();
      });
    }
    // Also call for IN_PROGRESS to not block the queue
    if (toolStatus === 'IN_PROGRESS' && shouldType && onTypingComplete) {
      requestAnimationFrame(() => {
        onTypingComplete();
      });
    }
    
    // For IN_PROGRESS without data, use title from metadata
    const title = planData?.title || message.metadata?.title || 'Plan';
    
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex-shrink-0 w-8 hidden md:block" />
        <div className="flex-1">
          <PlanChip
            plan={{
              title: title,
              content: planData?.content || '',
              tasks: planData?.tasks || [],
              dependencies: planData?.dependencies || null,
              join: planData?.join || 'all',
              status: planData?.status || 'planning',
            }}
            toolStatus={toolStatus}
          />
        </div>
      </div>
    );
  }

  // Request user attention: render as raw text with yellow indicator (swallow tool display)
  if (isUserAttentionMessage) {
    const attentionMessage = message.metadata?.attentionMessage || message.text;
    const isWaiting = message.metadata?.toolStatus === 'IN_PROGRESS';
    
    const handleStartExecution = () => {
      if (onSendMessage) {
        onSendMessage(
          'Please do not ask me anymore questions. I trust your judgment, intuition, and ability to make reasonable assumptions. Please proceed to the Autonomous Execution phase.'
        );
      }
    };
    
    return (
      <AttentionMessage
        attentionMessage={attentionMessage}
        isWaiting={isWaiting}
        shouldType={shouldType}
        onComplete={onTypingComplete}
        onStartExecution={onSendMessage ? handleStartExecution : undefined}
        isStreaming={isStreaming}
      />
    );
  }

  if (toolData) {
    return (
      <div className={cn("flex animate-in fade-in duration-300", !compact && "gap-3")}>
        {!compact && <div className="flex-shrink-0 w-8 hidden md:block" />}

        <div className="flex-1">
          <ToolMessage 
            data={toolData} 
            shouldType={shouldType}
            onComplete={onTypingComplete}
          />
        </div>
      </div>
    );
  }

  // User messages: right-aligned, with bubble, no icon, no label
  if (isUser) {
    return (
      <div className="flex justify-end animate-in fade-in duration-300">
        <div 
          className={cn(
            'inline-block max-w-[80%] px-4 py-2 rounded-lg border backdrop-blur-md',
            config.bg,
            config.border
          )}
        >
          <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
        </div>
      </div>
    );
  }

  // System/Assistant messages: keep original style with icon and label
  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className={cn(
        'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border',
        config.bg,
        config.border,
        // Add pulse animation for streaming messages
        isStreaming && 'animate-pulse'
      )}>
        <Icon className="h-4 w-4" />
      </div>
      
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-medium', config.text)}>
            {config.label}
          </span>
          {!isStreaming && (
            <span className="text-xs text-muted-foreground">
              {new Date(message.timestamp).toLocaleTimeString()}
            </span>
          )}
          {isStreaming && (
            <span className="text-xs text-muted-foreground animate-pulse">
              streaming...
            </span>
          )}
        </div>
        
        <div className={cn(
          'inline-block max-w-[80%] px-4 py-2 rounded-lg border',
          config.bg,
          config.border,
          isStreaming && 'border-purple-500/50'
        )}>
          <p className="text-sm whitespace-pre-wrap break-words">
            {message.text}
          </p>
        </div>
      </div>
    </div>
  );
}
