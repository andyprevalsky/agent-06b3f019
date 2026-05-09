/**
 * Hook that flattens the Message metadata shape into the `ToolMessageData` a
 * generic tool card expects. Streaming messages and ASSISTANT text messages
 * (no file_pointer) with content are also modeled as synthetic "Thought" tool
 * cards.
 */
import { useMemo } from 'react';
import type { Message } from '../../hooks';
import type { ToolMessageData } from './types';

interface UseToolDataArgs {
  message: Message;
  isStreaming: boolean;
  isAssistant: boolean;
  isTool: boolean;
  shouldType: boolean;
}

export function useToolData({
  message,
  isStreaming,
  isAssistant,
  isTool,
  shouldType,
}: UseToolDataArgs): ToolMessageData | null {
  return useMemo(() => {
    // Streaming messages render as text, not as a "Thought" tool card.
    if (isStreaming) return null;

    // ASSISTANT messages without an attachment render as synthetic "Thought" cards.
    if (isAssistant && !message.file_pointer) {
      if (message.text.trim().length === 0) return null;

      const assistantStatus: ToolMessageData['status'] = shouldType ? 'IN_PROGRESS' : 'FINISHED';
      return {
        toolCallId: message.message_id,
        toolName: 'thought',
        title: assistantStatus === 'IN_PROGRESS' ? 'Thinking' : 'Thought',
        status: assistantStatus,
        message: message.text,
      };
    }

    if (!isTool || !message.metadata) return null;

    const metadata = message.metadata;
    const actionMetadata =
      (metadata.sendMessageToUser as Record<string, unknown> | undefined) ||
      (metadata.requestUserAttention as Record<string, unknown> | undefined) ||
      null;
    const attentionMeta = actionMetadata ?? {};

    const rawStatus = metadata.toolStatus;
    const toolStatus: ToolMessageData['status'] =
      rawStatus === 'ERROR' ? 'FINISHED' : rawStatus || 'FINISHED';
    const toolName = (metadata.toolName as string | undefined) || '';

    return {
      toolCallId: (metadata.toolCallId as string | undefined) || '',
      toolName,
      title: (metadata.title as string | undefined) || 'Tool',
      status: toolStatus,
      message: toolName === 'cloud_agent' ? '' : message.text,
      error: Boolean(metadata.error),
      progressComplete: metadata.progressComplete as number | undefined,
      actionMetadata,
      // Countdown fields live on either the root or the attention sub-object.
      timeout:
        (metadata.timeout as number | undefined) ?? (attentionMeta.timeout as number | undefined),
      startTime:
        (metadata.startTime as string | undefined) ??
        (attentionMeta.startTime as string | undefined),
      simulated:
        (metadata.simulated as boolean | undefined) ??
        (attentionMeta.simulated as boolean | undefined),
      actionType: metadata.action_type as string | undefined,
      codeProvider: metadata.code_provider === 'codex' ? 'codex' : 'claude',
    };
  }, [isAssistant, shouldType, isTool, message, isStreaming]);
}
