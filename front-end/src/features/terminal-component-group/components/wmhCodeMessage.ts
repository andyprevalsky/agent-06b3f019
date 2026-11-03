import type { Message } from '../hooks';

/** Restore the code-chip contract for WMH transcripts recorded before it was emitted. */
export function normalizeWMHCodeMessage(message: Message): Message {
  const metadata = message.metadata;
  if (
    metadata?.world_model_simulated !== true ||
    metadata?.world_model_boundary !== 'spawn_claude_code_agent' ||
    metadata?.toolName !== 'spawn_agent' ||
    typeof metadata?.taskId !== 'string'
  ) {
    return message;
  }

  const terminal = metadata.toolStatus === 'FINISHED' || metadata.toolStatus === 'ERROR';
  // The producer reports failure as an ERROR status or an explicit success flag;
  // a successful task's output may quote failure words.
  const success =
    typeof metadata.success === 'boolean' ? metadata.success : metadata.toolStatus === 'FINISHED';
  return {
    ...message,
    metadata: {
      ...metadata,
      toolName: 'spawn_claude_code_agent',
      task_id: metadata.taskId,
      code_provider: 'claude',
      ...(terminal
        ? {
            action_type: 'task_complete',
            success,
            title: success ? '✓ Task Completed' : 'Task Incomplete',
          }
        : {}),
    },
  };
}
