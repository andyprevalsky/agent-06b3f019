import { Message } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Bot, User, Wrench, Info, ChevronRight } from 'lucide-react';
import { useState, useEffect } from 'react';

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
}

interface ParsedToolMessage {
  toolCallId: string;
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED';
  message: string;
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

function parseToolMessage(text: string): ParsedToolMessage | null {
  // Format: tool_call_id|||title|||status|||message
  const parts = text.split('|||');
  if (parts.length >= 3) {
    return {
      toolCallId: parts[0],
      title: parts[1],
      status: (parts[2] === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'FINISHED') as 'IN_PROGRESS' | 'FINISHED',
      message: parts[3] || '',
    };
  }
  return null;
}

function ToolMessage({ 
  parsed, 
  shouldType = false, 
  onComplete 
}: { 
  parsed: ParsedToolMessage; 
  shouldType?: boolean;
  onComplete?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasAnimated, setHasAnimated] = useState(false);
  const hasMessage = parsed.message.trim().length > 0;
  const isFinished = parsed.status === 'FINISHED';

  // Show chevron if: has message AND is finished
  const showChevron = hasMessage && isFinished;

  // If we should animate and haven't animated yet, start expanded
  const shouldBeExpanded = (shouldType && !hasAnimated) || isExpanded;

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
        <span className={cn(
          "text-sm font-medium",
          parsed.status === 'IN_PROGRESS' && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
          parsed.status === 'FINISHED' && "text-foreground"
        )}>
          {parsed.title}
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
                  text={parsed.message} 
                  shouldAnimate={true}
                  onComplete={handleAnimationComplete}
                />
              ) : (
                parsed.message
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({ message, shouldType = false, onTypingComplete }: MessageBubbleProps) {
  const config = roleConfig[message.role];
  const Icon = config.icon;
  const isUser = message.role === 'USER';
  const isTool = message.role === 'TOOL';
  const isAssistant = message.role === 'ASSISTANT';
  const isSystem = message.role === 'SYSTEM';

  // Parse tool message if applicable
  const parsedTool = isTool ? parseToolMessage(message.text) : null;

  // Tool messages: plain text, no bubble, no icon
  if (isTool && parsedTool) {
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        {/* Empty space where icon would be to align with agent messages */}
        <div className="flex-shrink-0 w-8" />
        
        <div className="flex-1">
          <ToolMessage 
            parsed={parsedTool} 
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
