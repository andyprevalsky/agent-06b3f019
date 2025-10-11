import { Message } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Bot, User, Wrench, Info, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface MessageBubbleProps {
  message: Message;
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

function ToolMessage({ parsed }: { parsed: ParsedToolMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasMessage = parsed.message.trim().length > 0;

  return (
    <div className="space-y-2">
      {/* Title row */}
      <div 
        className={cn(
          "flex items-center gap-2",
          hasMessage && "cursor-pointer hover:opacity-80 transition-opacity"
        )}
        onClick={hasMessage ? () => setIsExpanded(!isExpanded) : undefined}
      >
        <span className={cn(
          "text-sm font-medium",
          parsed.status === 'IN_PROGRESS' && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
          parsed.status === 'FINISHED' && "text-foreground"
        )}>
          {parsed.title}
        </span>
        {hasMessage && (
          <ChevronRight 
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              isExpanded && "rotate-90"
            )} 
          />
        )}
      </div>

      {/* Expandable message content */}
      {hasMessage && isExpanded && (
        <div className="pl-4 border-l-2 border-border animate-in slide-in-from-top-2 duration-200">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
            {parsed.message}
          </p>
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const config = roleConfig[message.role];
  const Icon = config.icon;
  const isUser = message.role === 'USER';
  const isTool = message.role === 'TOOL';

  // Parse tool message if applicable
  const parsedTool = isTool ? parseToolMessage(message.text) : null;

  // Tool messages: plain text, no bubble, no icon
  if (isTool && parsedTool) {
    return (
      <div className="flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
        {/* Empty space where icon would be to align with agent messages */}
        <div className="flex-shrink-0 w-8" />
        
        <div className="flex-1">
          <ToolMessage parsed={parsedTool} />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300', isUser && 'flex-row-reverse')}>
      <div className={cn(
        'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border',
        config.bg,
        config.border
      )}>
        <Icon className="h-4 w-4" />
      </div>
      
      <div className={cn('flex-1 space-y-1', isUser && 'flex flex-col items-end')}>
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

