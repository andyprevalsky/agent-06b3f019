import { Message } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Bot, User, Wrench, Terminal, Info } from 'lucide-react';

interface MessageBubbleProps {
  message: Message;
}

const roleConfig = {
  SYSTEM: {
    icon: Info,
    bg: 'bg-blue-500/10 dark:bg-blue-500/20',
    border: 'border-blue-500/30',
    text: 'text-blue-700 dark:text-blue-300',
    label: 'System',
  },
  AGENT: {
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
    bg: 'bg-green-500/10 dark:bg-green-500/20',
    border: 'border-green-500/30',
    text: 'text-green-700 dark:text-green-300',
    label: 'Tool',
  },
  STATUS: {
    icon: Terminal,
    bg: 'bg-yellow-500/10 dark:bg-yellow-500/20',
    border: 'border-yellow-500/30',
    text: 'text-yellow-700 dark:text-yellow-300',
    label: 'Status',
  },
};

export default function MessageBubble({ message }: MessageBubbleProps) {
  const config = roleConfig[message.role];
  const Icon = config.icon;
  const isUser = message.role === 'USER';

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

