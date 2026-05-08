/**
 * The leading 16x16 icon shown on a tool card. Uses:
 *   - ThinkingAnimation for "thought" tools in progress,
 *   - the x402 / Claude Code lockup icons for their tool families,
 *   - or a generic lucide icon resolved from `toolIcons`.
 */
import { Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getToolIcon,
  isX402Tool,
  x402IconSrc,
  isClaudeCodeTool,
  claudeCodeIconSrc,
} from '@/lib/toolIcons';
import ThinkingAnimation from '@/components/ThinkingAnimation';

interface ToolMessageIconProps {
  isThought: boolean;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  toolName?: string;
  actionType?: string;
  error?: boolean;
}

export function ToolMessageIcon({
  isThought,
  status,
  toolName,
  actionType,
  error,
}: ToolMessageIconProps) {
  if (isThought) {
    return status === 'IN_PROGRESS' ? (
      <ThinkingAnimation
        dataUrl="/thinking_animations.txt"
        autoplay
        loop
        className="w-4 h-4 flex-shrink-0"
        style={{ width: '16px', height: '16px' }}
      />
    ) : (
      <div className="h-4 w-4 flex-shrink-0" />
    );
  }

  if (toolName && isX402Tool(toolName)) {
    return (
      <img
        src={x402IconSrc}
        alt="x402"
        className="h-4 w-4 flex-shrink-0 opacity-60 dark:invert dark:opacity-70"
      />
    );
  }

  if (toolName && isClaudeCodeTool(toolName)) {
    return <img src={claudeCodeIconSrc} alt="Claude Code" className="h-4 w-4 flex-shrink-0" />;
  }

  const Icon = actionType ? getToolIcon(actionType) : toolName ? getToolIcon(toolName) : Wrench;
  return (
    <Icon
      className={cn(
        'h-4 w-4 flex-shrink-0',
        error && 'text-red-600 dark:text-red-400',
        !error && status === 'IN_PROGRESS' && 'text-muted-foreground',
        !error && status === 'FINISHED' && 'text-muted-foreground',
      )}
    />
  );
}
