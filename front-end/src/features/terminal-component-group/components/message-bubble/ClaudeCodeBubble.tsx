/**
 * spawn_claude_code_agent tool → ClaudeCodeChip.
 *
 * Three visible states:
 *   - IN_PROGRESS (toolStatus)           → "spinning_up"
 *   - action_type=claude_code_started   → live terminal
 *   - action_type=task_complete         → completed / failed terminal (expandable)
 *
 * Calls onTypingComplete immediately — ClaudeCodeChip handles its own state.
 */
import type { Message } from '../../hooks';
import type { CodeProvider } from '../../types';
import ClaudeCodeChip from '../ClaudeCodeChip';

interface ClaudeCodeBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
}

export function ClaudeCodeBubble({ message, shouldType, onTypingComplete }: ClaudeCodeBubbleProps) {
  const metadata = message.metadata;
  const taskId = (metadata?.task_id as string) || 'pending';
  const wsUrl = metadata?.ws_url as string | undefined;
  const codeProvider = metadata?.code_provider === 'codex' ? 'codex' : ('claude' as CodeProvider);

  if (shouldType && onTypingComplete) {
    requestAnimationFrame(() => onTypingComplete());
  }

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 min-w-0">
        <ClaudeCodeChip taskId={taskId} wsUrl={wsUrl} codeProvider={codeProvider} />
      </div>
    </div>
  );
}
