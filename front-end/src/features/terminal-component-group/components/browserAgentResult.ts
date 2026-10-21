/** Match terminal browser cards; progress and pending attention stay interactive. */
import type { Message } from '../hooks';

export function isBrowserAgentResult(message: Message): boolean {
  const metadata = message.metadata;
  const terminalAction =
    metadata?.action_type === 'task_complete' || metadata?.action_type === 'session_paused';
  return Boolean(
    message.role === 'TOOL' &&
    metadata?.toolName === 'spawn_browser_agent' &&
    !metadata?.subAgentId &&
    (metadata?.toolStatus === 'FINISHED' || metadata?.toolStatus === 'ERROR') &&
    (terminalAction || (!metadata?.task_id && metadata?.action_type == null)),
  );
}
