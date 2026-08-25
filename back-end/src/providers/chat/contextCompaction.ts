/**
 * Durable chat-context compaction checkpoints.
 *
 * Mirrors agents/helpers/context_compaction.py and the Claude Code /
 * OpenClaw compact-boundary contract: raw history stays in the DB for UI/audit,
 * while the model sees the latest compressed snapshot plus post-checkpoint rows.
 */

import type { ChatMessage } from './initialContext';

export const CONTEXT_COMPACTION_KEY = 'contextCompaction';

export interface ContextCompactionMetadata {
  version: number;
  compressedContext: ChatMessage[];
  compressedMessageCount: number;
}

function metadata(message: ChatMessage): Record<string, unknown> {
  return message.metadata ?? {};
}

export function isContextCompactionCheckpoint(message: ChatMessage): boolean {
  const checkpoint = metadata(message)[CONTEXT_COMPACTION_KEY];
  return (
    typeof checkpoint === 'object' &&
    checkpoint !== null &&
    Array.isArray((checkpoint as ContextCompactionMetadata).compressedContext)
  );
}

export function isExcludedFromModel(message: ChatMessage): boolean {
  return metadata(message).excludeFromModel === true;
}

export function buildContextCompactionMetadata(
  compressedContext: ChatMessage[]
): ContextCompactionMetadata {
  return {
    version: 1,
    compressedContext: structuredClone(compressedContext),
    compressedMessageCount: compressedContext.length,
  };
}

function checkpointBoundaryMarker(checkpointMessage: ChatMessage): ChatMessage {
  const meta = metadata(checkpointMessage);
  return {
    role: 'SYSTEM',
    text: '',
    metadata: {
      toolName: meta.toolName ?? 'context_reset',
      contextCompactionBoundary: true,
      excludeFromModel: true,
    },
  };
}

export function latestContextCompactionCheckpoint(messages: ChatMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isContextCompactionCheckpoint(messages[index])) return index;
  }
  return null;
}

export function projectModelContextAfterCompaction(messages: ChatMessage[]): ChatMessage[] {
  const checkpointIndex = latestContextCompactionCheckpoint(messages);
  if (checkpointIndex === null) return messages;

  const checkpointMessage = messages[checkpointIndex];
  const checkpoint = metadata(checkpointMessage)[CONTEXT_COMPACTION_KEY] as
    | ContextCompactionMetadata
    | undefined;
  const compressedContext = checkpoint?.compressedContext;
  if (!Array.isArray(compressedContext)) return messages;

  return [
    ...structuredClone(compressedContext),
    checkpointBoundaryMarker(checkpointMessage),
    ...structuredClone(messages.slice(checkpointIndex + 1)),
  ];
}
