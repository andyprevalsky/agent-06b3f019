/**
 * Hook that flattens the Message metadata shape into the `ToolMessageData` a
 * generic tool card expects. Streaming messages and ASSISTANT text messages
 * (no file_pointer) with content are also modeled as synthetic "Thought" tool
 * cards. Agent-to-agent rows map through agentToolData.ts first.
 */
import { useMemo } from 'react';
import { userFacingMessageText } from '@/lib/userFacingMessage';
import type { Message } from '../../hooks';
import { buildAgentToolData } from './agentToolData';
import type { ToolMessageData } from './types';

interface UseToolDataArgs {
  message: Message;
  isStreaming: boolean;
  isAssistant: boolean;
  isTool: boolean;
}

/** The row's text for the user; a code agent's own output (verbatimText) is never scrubbed. */
function visibleText(message: Message): string {
  return message.metadata?.verbatimText === true
    ? message.text
    : userFacingMessageText(message.text);
}

export function useToolData({
  message,
  isStreaming,
  isAssistant,
  isTool,
}: UseToolDataArgs): ToolMessageData | null {
  return useMemo(() => {
    // Streaming messages render as text, not as a "Thought" tool card.
    if (isStreaming) return null;

    // Agent-to-agent rows (messages, completions, agent tools) are tool cards,
    // never a user bubble or a synthetic "Thought" — even with role ASSISTANT.
    const agentData = buildAgentToolData(message);
    if (agentData) return agentData;

    // ASSISTANT messages without an attachment render as synthetic "Thought" cards.
    // Status is always FINISHED: the card has no typing animation, so a
    // transient IN_PROGRESS keyed off the animation queue would only flash the
    // card open for one frame before the instant onComplete collapses it.
    if (isAssistant && !message.file_pointer) {
      if (message.text.trim().length === 0) return null;

      return {
        toolCallId: message.message_id,
        toolName: 'thought',
        title: 'Thought',
        status: 'FINISHED',
        message: visibleText(message),
      };
    }

    if (!isTool || !message.metadata) return null;

    const metadata = message.metadata;
    const actionMetadata =
      (metadata.sendMessageToUser as Record<string, unknown> | undefined) ||
      (metadata.requestUserAttention as Record<string, unknown> | undefined) ||
      null;
    const attentionMeta = actionMetadata ?? {};
    const authMeta = metadata.requestUserAuthentication as Record<string, unknown> | undefined;
    const authTaskId =
      typeof authMeta?.taskId === 'string'
        ? authMeta.taskId
        : typeof metadata.task_id === 'string'
          ? metadata.task_id
          : undefined;

    const rawStatus = metadata.toolStatus;
    const toolStatus: ToolMessageData['status'] =
      rawStatus === 'ERROR' ? 'FINISHED' : rawStatus || 'FINISHED';
    const toolName = (metadata.toolName as string | undefined) || '';
    const title = (metadata.title as string | undefined) || 'Tool';
    const hideToolMessage =
      toolName === 'cloud_agent' || (toolName === 'thought' && rawStatus === 'IN_PROGRESS');

    return {
      toolCallId: (metadata.toolCallId as string | undefined) || '',
      toolName,
      title,
      status: toolStatus,
      message: hideToolMessage ? '' : visibleText(message),
      error: Boolean(metadata.error),
      progressComplete: metadata.progressComplete as number | undefined,
      actionMetadata,
      authAssistance: authMeta ? { taskId: authTaskId } : undefined,
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
  }, [isAssistant, isTool, message, isStreaming]);
}
