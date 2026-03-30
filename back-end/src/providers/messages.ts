/**
 * Message helper functions - shared between API routes and internal handlers.
 * Both worker (via API) and chat handler use the same path for message creation.
 */

import { Prisma } from '@prisma/client';
import { prisma } from './database';

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
 * The Supabase DB trigger will broadcast INSERT event to frontend.
 */
export async function createMessage(params: CreateMessageParams) {
  const message = await prisma.message.create({
    data: {
      agentId: params.agentId,
      text: params.text,
      role: params.role,
      metadata: (params.metadata as Prisma.InputJsonValue) || undefined,
      filePointer: params.filePointer || undefined,
      timestamp: new Date(),
    },
  });

  return message;
}
