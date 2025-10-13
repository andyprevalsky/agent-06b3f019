import { Message } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Bot, User, Wrench, Info, ChevronRight } from 'lucide-react';
import { useState, useEffect, useMemo, memo } from 'react';
import SubAgentToolBubble from './SubAgentToolBubble';

interface AnimatedTextProps {
  text: string;
  shouldAnimate: boolean;
  onComplete?: () => void;
}

function AnimatedText({ text, shouldAnimate, onComplete }: AnimatedTextProps) {
  if (!shouldAnimate) {
    return <>{text}</>;
  }

  // Split into words and chunk them
  const words = text.split(' ');
  const chunkSize = 5;
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    chunks.push(chunk);
  }

  // Handler for when the LAST chunk finishes animating
  const handleLastChunkAnimationEnd = () => {
    if (onComplete) {
      onComplete();
    }
  };

  return (
    <>
      {chunks.map((chunk, index) => (
        <span
          key={index}
          className="opacity-0"
          style={{
            animation: 'fadeIn 200ms ease-out forwards',
            animationDelay: `${index * 40}ms`,
          }}
          onAnimationEnd={index === chunks.length - 1 ? handleLastChunkAnimationEnd : undefined}
        >
          {chunk}
          {index < chunks.length - 1 ? ' ' : ''}
        </span>
      ))}
      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
      `}</style>
    </>
  );
}

interface MessageBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
}

interface ToolMessageData {
  toolCallId: string;
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED';
  message: string;
  error?: boolean;
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
  
  // Extract emoji from title (memoized)
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
        {/* Emoji with grayscale filter - separate from text to avoid bg-clip-text interference */}
        {emoji && (
          <span 
            className="text-sm font-medium"
            style={{ filter: 'grayscale(1) brightness(0)' }}
          >
            {emoji}
          </span>
        )}
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

      {/* Expandable message content */}
      {hasMessage && shouldBeExpanded && (
        <div className="overflow-hidden">
          <div className="pl-4 border-l-2 border-border">
            <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
              {shouldType && !hasAnimated ? (
                <AnimatedText 
                  text={data.message} 
                  shouldAnimate={true}
                  onComplete={handleAnimationComplete}
                />
              ) : (
                data.message
              )}
            </p>
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
      title: message.metadata.title || 'Tool',
      status: message.metadata.toolStatus || 'FINISHED',
      message: message.text,
      error: message.metadata.error || false,
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

  // Assistant messages: plain text, no bubble, no icon
  if (isAssistant) {
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        {/* Empty space where icon would be to align with other content */}
        <div className="flex-shrink-0 w-8" />
        
        <div className="flex-1">
          <p className="text-sm whitespace-pre-wrap break-words text-foreground">
            {shouldType ? (
              <AnimatedText 
                text={message.text} 
                shouldAnimate={true}
                onComplete={onTypingComplete}
              />
            ) : (
              message.text
            )}
          </p>
        </div>
      </div>
    );
  }

  // User messages: right-aligned, with bubble, no icon, no label
  if (isUser) {
    return (
      <div className="flex justify-end animate-in fade-in duration-300">
        <div className={cn(
          'inline-block max-w-[80%] px-4 py-2 rounded-lg border',
          config.bg,
          config.border
        )}>
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
