/**
 * Message helper functions - shared between API routes and internal handlers.
 * Both worker (via API) and chat handler use the same path for message creation.
 */

import { Prisma, type Message } from '@prisma/client';
import { createHash } from 'node:crypto';
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

function normalizeJsonForCompare(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonForCompare);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, entryValue]) => [key, normalizeJsonForCompare(entryValue)])
    );
  }
  return value;
}

function metadataEquals(
  incoming: Record<string, unknown> | null | undefined,
  existing: Prisma.JsonValue | null | undefined
): boolean {
  return (
    JSON.stringify(normalizeJsonForCompare(incoming ?? null)) ===
    JSON.stringify(normalizeJsonForCompare(existing ?? null))
  );
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

  const candidates = await prisma.message.findMany({
    where: {
      agentId: params.agentId,
      role: 'TOOL',
      text: params.text,
      filePointer: { equals: Prisma.AnyNull },
      AND: jsonPredicates,
    },
    orderBy: { timestamp: 'desc' },
  });

  return (
    candidates.find((candidate) => metadataEquals(params.metadata, candidate.metadata)) ?? null
  );
}

function idempotentMessageId(params: CreateMessageParams): string | null {
  if (params.role !== 'USER' || params.metadata?.isResponseSchemaUpdate !== true) return null;
  const key = stringMetadataValue(params.metadata, 'idempotencyKey');
  if (key === null) return null;

  const hex = createHash('sha256').update(`${params.agentId}:${key}`).digest('hex').slice(0, 32);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function findIdempotentMessage(params: CreateMessageParams) {
  const id = idempotentMessageId(params);
  return id === null ? null : prisma.message.findUnique({ where: { id } });
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
  const idempotentId = idempotentMessageId(params);
  const idempotentDuplicate = await findIdempotentMessage(params);
  if (idempotentDuplicate !== null) {
    log.info('deduped idempotent message', {
      agent_id: params.agentId,
      message_id: idempotentDuplicate.id,
    });
    return idempotentDuplicate;
  }

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

  let message: Message;
  try {
    message = await prisma.message.create({
      data: {
        ...(idempotentId === null ? {} : { id: idempotentId }),
        agentId: params.agentId,
        text: params.text,
        role: params.role,
        metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
        filePointer: params.filePointer ?? undefined,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    // Identical activity attempts can overlap after a timeout. The primary key
    // makes creation atomic; the loser returns the winner's durable row.
    if (
      idempotentId !== null &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const winner = await prisma.message.findUnique({ where: { id: idempotentId } });
      if (winner !== null) return winner;
    }
    throw error;
  }

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
