/**
 * The leading 16x16 icon shown on a tool card. Uses:
 *   - the lightbulb for "thought" rows (live or finished), like any tool icon,
 *   - the x402 / Claude Code lockup icons for their tool families,
 *   - or a generic lucide icon resolved from `toolIcons`.
 */
import { Lightbulb, Wrench } from 'lucide-react';
import CodexIcon from '@/assets/codex-color.svg';
import { cn } from '@/lib/utils';
import type { CodeProvider } from '../../types';
import {
  getToolIcon,
  isX402Tool,
  x402IconSrc,
  isClaudeCodeTool,
  claudeCodeIconSrc,
} from '@/lib/toolIcons';

interface ToolMessageIconProps {
  isThought: boolean;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  toolName?: string;
  actionType?: string;
  error?: boolean;
  codeProvider?: CodeProvider;
}

export function ToolMessageIcon({
  isThought,
  status,
  toolName,
  actionType,
  error,
  codeProvider,
}: ToolMessageIconProps) {
  if (isThought) {
    return <Lightbulb className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
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
    if (codeProvider === 'codex') {
      return <img src={CodexIcon} alt="Codex" className="h-4 w-4 flex-shrink-0" />;
    }
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
