import { Message, respondToAttentionRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Bot, User, Wrench, Info, ChevronRight } from 'lucide-react';
import { useState, useEffect, useMemo, memo } from 'react';
import { Button } from '@/components/ui/button';
import SubAgentToolBubble from './SubAgentToolBubble';
import { MarkdownText } from './MarkdownText';
import { getToolIcon } from '@/lib/toolIcons';
import { useToast } from '@/hooks/use-toast';

interface MessageBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
}

interface ToolMessageData {
  toolCallId: string;
  toolName?: string;
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED';
  message: string;
  error?: boolean;
  progressComplete?: number; // 0-100 or 0-1, optional - if present shows progress bar
  actionMetadata?: Record<string, any> | null;
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
  const { toast } = useToast();
  const actionMetadata = data.actionMetadata;
  
  // Get tool icon based on toolName
  const ToolIcon = data.toolName ? getToolIcon(data.toolName) : Wrench;
  
  // Extract emoji from title (memoized) - keeping for backward compatibility
  const { emoji, text: titleText } = useMemo(() => extractEmoji(data.title), [data.title]);
  
  // Memoize computed values
  const hasMessage = useMemo(() => data.message.trim().length > 0, [data.message]);
  const isFinished = useMemo(() => data.status === 'FINISHED', [data.status]);
  const showChevron = useMemo(() => hasMessage && isFinished, [hasMessage, isFinished]);
  const shouldBeExpanded = useMemo(() => 
    (shouldType && !hasAnimated) || isExpanded, 
    [shouldType, hasAnimated, isExpanded]
  );

  // Handle animation completion - collapse after animating
  const handleAnimationComplete = () => {
    console.log(`[${performance.now().toFixed(2)}] 🔽 COLLAPSE: Tool message collapsing`);
    setHasAnimated(true);
    setIsExpanded(false); // Collapse after animation
    
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

  const showProgressBar = progressPercent !== undefined && data.status === 'IN_PROGRESS';

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
    <div className="space-y-2">
      {/* Title row */}
      <div 
        className={cn(
          "flex items-center gap-2",
          hasMessage && isFinished && "cursor-pointer hover:opacity-80 transition-opacity"
        )}
        onClick={hasMessage && isFinished ? () => setIsExpanded(!isExpanded) : undefined}
      >
        {/* Tool Icon */}
        <ToolIcon className={cn(
          "h-4 w-4 flex-shrink-0",
          data.error && "text-red-600 dark:text-red-400",
          !data.error && data.status === 'IN_PROGRESS' && "text-muted-foreground",
          !data.error && data.status === 'FINISHED' && "text-muted-foreground"
        )} />
        
        {/* Text with shimmer animation */}
        <span 
          className={cn(
            "text-sm font-medium",
            data.error && "text-red-600 dark:text-red-400",
            !data.error && data.status === 'IN_PROGRESS' && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
            !data.error && data.status === 'FINISHED' && "text-foreground"
          )}
        >
          {titleText}
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

      {/* Expandable message content */}
      {hasMessage && shouldBeExpanded && (
        <div className="overflow-hidden">
          <div className="pl-4 border-l-2 border-border">
            <MarkdownText
              text={data.message}
              shouldAnimate={shouldType && !hasAnimated}
              onComplete={handleAnimationComplete}
              className="text-sm text-muted-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
});

export default function MessageBubble({ message, shouldType = false, onTypingComplete, onNavigateToAgent }: MessageBubbleProps) {
  const config = roleConfig[message.role];
  const Icon = config.icon;
  const isUser = message.role === 'USER';
  const isTool = message.role === 'TOOL';
  const isAssistant = message.role === 'ASSISTANT';
  const isSystem = message.role === 'SYSTEM';

  // Check if this is a sub-agent tool message (ones that link to an agent_id)
  const isSubAgentTool = !!message.metadata?.subAgentId;

  // Memoize tool data to prevent flickers on re-renders
  const toolData = useMemo(() => {
    if (!isTool || !message.metadata) return null;
    
    return {
      toolCallId: message.metadata.toolCallId || '',
      toolName: message.metadata.toolName || '',
      title: message.metadata.title || 'Tool',
      status: message.metadata.toolStatus || 'FINISHED',
      message: message.text,
      error: message.metadata.error || false,
      progressComplete: message.metadata.progressComplete,
      actionMetadata: message.metadata.requestUserAttention,
    } as ToolMessageData;
  }, [isTool, message.metadata, message.text]);

  // Sub-agent tool messages: use special SubAgentToolBubble component
  const subAgentBubble = useMemo(() => {
    if (!isSubAgentTool || !message.metadata) return null;

    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        {/* Empty space where icon would be to align with agent messages */}
        <div className="flex-shrink-0 w-8" />
        
        <div className="flex-1">
          <SubAgentToolBubble
            toolCallId={message.metadata.toolCallId || ''}
            title={message.metadata.title || 'Sub-agent'}
            message={message.text}
            status={message.metadata.toolStatus || 'FINISHED'}
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

  // Regular tool messages: all must have metadata
  if (isTool) {
    // All tool messages must have metadata
    if (!message.metadata) {
      console.error('Tool message missing metadata:', message);
      // Render as plain text fallback
      return (
        <div className="flex gap-3 animate-in fade-in duration-300">
          <div className="flex-shrink-0 w-8" />
          <div className="flex-1">
            <div className="text-sm text-muted-foreground">
              [Invalid tool message: missing metadata]
            </div>
          </div>
        </div>
      );
    }

    // Verifier messages: no indent (align with user messages)
    const isVerifierMessage = message.metadata.verifierMessage === true;

    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex-shrink-0 w-8" />
        
        <div className="flex-1">
          <ToolMessage 
            data={toolData!} 
            shouldType={shouldType}
            onComplete={onTypingComplete}
          />
        </div>
      </div>
    );
  }

  // Assistant messages: markdown support, no bubble, no icon
  if (isAssistant) {
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        {/* Empty space where icon would be to align with other content */}
        <div className="flex-shrink-0 w-8" />
        
        <div className="flex-1">
          <MarkdownText
            text={message.text}
            shouldAnimate={shouldType}
            onComplete={onTypingComplete}
            className="text-sm text-foreground"
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

  // System messages: keep original style with icon and label
  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className={cn(
        'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border',
        config.bg,
        config.border
      )}>
        <Icon className="h-4 w-4" />
      </div>
      
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-medium', config.text)}>
            {config.label}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
        
        <div className={cn(
          'inline-block max-w-[80%] px-4 py-2 rounded-lg border',
          config.bg,
          config.border
        )}>
          <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
        </div>
      </div>
    </div>
  );
}
