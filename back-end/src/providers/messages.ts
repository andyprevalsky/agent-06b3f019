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

/**
 * Create a message in the database.
 * This is the single path for all message creation - used by:
 * - POST /api/agents/:id/messages (worker and user messages)
 * - Chat handler (ASSISTANT responses)
 *
 * Broadcasts INSERT event to frontend via Supabase Realtime.
 */
export async function createMessage(params: CreateMessageParams) {
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
