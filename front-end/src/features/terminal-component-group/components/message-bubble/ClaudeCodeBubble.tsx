/**
 * spawn_claude_code_agent tool → ClaudeCodeChip.
 *
 * Output files have a collapsed disclosure inside this owning code result.
 * Three visible states:
 *   - IN_PROGRESS (toolStatus)           → "spinning_up"
 *   - action_type=claude_code_started   → live terminal
 *   - action_type=task_complete         → completed / failed terminal (expandable)
 *
 * Calls onTypingComplete immediately — ClaudeCodeChip handles its own state.
 *
 * STATE MACHINE (task_id resolution):
 *   [anchor has task_id] → use it
 *   [anchor missing task_id] → recover from same-toolCallId sibling in full
 *     agent transcript (handler cancel can omit task_id when TRY_CANCEL races;
 *     toolCallId dedupe may then anchor the chip on that bare cancel message)
 *   [no sibling task_id] → "pending" (chip stays spinning_up until a real id arrives)
 */
import { useToolArtifacts } from '../toolArtifactContext';
import { ToolArtifacts } from '../ToolArtifacts';
import { useMemo } from 'react';
import { useAgentContext, type Message } from '../../hooks';
import type { CodeProvider } from '../../types';
import ClaudeCodeChip from '../ClaudeCodeChip';

interface ClaudeCodeBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
}

function resolveTaskId(message: Message, messages: Message[]): string {
  const metadata = message.metadata;
  const direct = metadata?.task_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const toolCallId = metadata?.toolCallId;
  if (typeof toolCallId === 'string' && toolCallId.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const siblingMeta = messages[i]?.metadata;
      if (siblingMeta?.toolCallId !== toolCallId) continue;
      const siblingTaskId = siblingMeta?.task_id;
      if (typeof siblingTaskId === 'string' && siblingTaskId.length > 0) {
        return siblingTaskId;
      }
    }
  }

  return 'pending';
}

export function ClaudeCodeBubble({ message, shouldType, onTypingComplete }: ClaudeCodeBubbleProps) {
  const { messages, selectedAgentId } = useAgentContext();
  const artifacts = useToolArtifacts();
  const metadata = message.metadata;
  const taskId = useMemo(() => resolveTaskId(message, messages), [message, messages]);
  const wsUrl = metadata?.ws_url as string | undefined;
  const codeProvider = metadata?.code_provider === 'codex' ? 'codex' : ('claude' as CodeProvider);

  if (shouldType && onTypingComplete) {
    requestAnimationFrame(() => onTypingComplete());
  }

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 min-w-0">
        <ClaudeCodeChip
          taskId={taskId}
          wsUrl={wsUrl}
          codeProvider={codeProvider}
          toolCallId={typeof metadata?.toolCallId === 'string' ? metadata.toolCallId : undefined}
        />
        {artifacts.length > 0 && (
          <ToolArtifacts artifacts={artifacts} agentId={selectedAgentId || undefined} />
        )}
      </div>
    </div>
  );
}
