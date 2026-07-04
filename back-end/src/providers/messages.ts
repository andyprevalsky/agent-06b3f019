/**
 * Message helper functions - shared between API routes and internal handlers.
 * Both worker (via API) and chat handler use the same path for message creation.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './database';
import { broadcastMessageInsert } from './chat/supabaseBroadcast';
import { createLogger } from './logger';

const log = createLogger('Messages');

export interface CreateMessageParams {
  agentId: string;
  text: string;
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  metadata?: Record<string, unknown> | null;
  filePointer?: object | null; // FilePointer for file attachment messages (JSON)
}

function stringMetadataValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function findDuplicateToolMessage(params: CreateMessageParams) {
  if (params.role !== 'TOOL' || (params.filePointer !== undefined && params.filePointer !== null)) {
    return null;
  }
  const toolCallId = stringMetadataValue(params.metadata, 'toolCallId');
  const toolStatus = stringMetadataValue(params.metadata, 'toolStatus');
  const title = stringMetadataValue(params.metadata, 'title');
  if (toolCallId === null || toolStatus === null) return null;

  const jsonPredicates: Prisma.MessageWhereInput[] = [
    { metadata: { path: ['toolCallId'], equals: toolCallId } },
    { metadata: { path: ['toolStatus'], equals: toolStatus } },
  ];
  if (title !== null) {
    jsonPredicates.push({ metadata: { path: ['title'], equals: title } });
  }

  return prisma.message.findFirst({
    where: {
      agentId: params.agentId,
      role: 'TOOL',
      text: params.text,
      AND: jsonPredicates,
    },
    orderBy: { timestamp: 'desc' },
  });
}

/**
 * Create a message in the database.
 * This is the single path for all message creation - used by:
 * - POST /api/agents/:id/messages (worker and user messages)
 * - Chat handler (ASSISTANT responses)
 *
 * Broadcasts INSERT event to frontend via Supabase Realtime.
 */
export async function createMessage(params: CreateMessageParams) {
  const duplicate = await findDuplicateToolMessage(params);
  if (duplicate !== null) {
    log.info('deduped duplicate tool message', {
      agent_id: params.agentId,
      tool_call_id: stringMetadataValue(params.metadata, 'toolCallId'),
      tool_status: stringMetadataValue(params.metadata, 'toolStatus'),
      message_id: duplicate.id,
    });
    return duplicate;
  }

  const message = await prisma.message.create({
    data: {
      agentId: params.agentId,
      text: params.text,
      role: params.role,
      metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
      filePointer: params.filePointer ?? undefined,
      timestamp: new Date(),
    },
  });

  // Broadcast INSERT event to frontend (replaces Supabase DB trigger)
  broadcastMessageInsert(params.agentId, {
    id: message.id,
    timestamp: message.timestamp,
    text: message.text,
    role: message.role,
    metadata: params.metadata as Record<string, unknown> | undefined,
    filePointer: params.filePointer,
  }).catch((err: unknown) =>
    log.error('broadcast failed', { err: err instanceof Error ? err.message : String(err) })
  );

  return message;
}
