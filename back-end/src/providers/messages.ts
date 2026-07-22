/** Shared message creation for API routes, workers, and chat handlers. */

import { Prisma, type Message } from '@prisma/client';
import { createHash } from 'node:crypto';
import { broadcastMessageInsert } from './chat/supabaseBroadcast';
import { prisma } from './database';
import { createLogger } from './logger';
import {
  messageMetadata,
  metadataEquals,
  persistToolLifecycleMessage,
  stringMetadataValue,
  toolLifecycleIdentity,
} from './toolLifecycleMessages';

const log = createLogger('Messages');

export interface CreateMessageParams {
  agentId: string;
  text: string;
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  metadata?: Record<string, unknown> | null;
  filePointer?: object | null;
  /** The caller generated a unique toolCallId inside a non-retried request. */
  skipDuplicateToolCheck?: boolean;
  /** Finalize lifecycle writes that do not belong to the Agent's current workflow. */
  enforceCurrentWorkflowGeneration?: boolean;
  /** Server-only authority to create a deployment fence. */
  allowDeploymentFinalizer?: boolean;
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

async function persistOrdinaryMessage(
  params: CreateMessageParams,
  idempotentId: string | null
): Promise<{ message: Message; created: boolean }> {
  const duplicate =
    params.skipDuplicateToolCheck === true ? null : await findDuplicateToolMessage(params);
  if (duplicate !== null) return { message: duplicate, created: false };
  try {
    const message = await prisma.message.create({
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
    return { message, created: true };
  } catch (error) {
    if (
      idempotentId !== null &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const winner = await prisma.message.findUnique({ where: { id: idempotentId } });
      if (winner !== null) return { message: winner, created: false };
    }
    throw error;
  }
}

function logUncreatedMessageWrite(params: CreateMessageParams, message: Message): void {
  log.info('deduplicated or fenced message write', {
    agent_id: params.agentId,
    tool_call_id: stringMetadataValue(params.metadata, 'toolCallId'),
    incoming_tool_status: stringMetadataValue(params.metadata, 'toolStatus'),
    existing_tool_status: stringMetadataValue(messageMetadata(message), 'toolStatus'),
    message_id: message.id,
  });
}

function broadcastCreatedMessage(params: CreateMessageParams, message: Message): void {
  broadcastMessageInsert(params.agentId, {
    id: message.id,
    timestamp: message.timestamp,
    text: message.text,
    role: message.role,
    metadata: messageMetadata(message) ?? undefined,
    filePointer:
      message.filePointer === null ? undefined : (message.filePointer as Record<string, unknown>),
  }).catch((err: unknown) =>
    log.error('broadcast failed', { err: err instanceof Error ? err.message : String(err) })
  );
}

/** Create, deduplicate, fence, persist, and broadcast one message. */
export async function createMessage(params: CreateMessageParams): Promise<Message> {
  const idempotentId = idempotentMessageId(params);
  const idempotentDuplicate = await findIdempotentMessage(params);
  if (idempotentDuplicate !== null) return idempotentDuplicate;

  const lifecycle = toolLifecycleIdentity(params);
  const result =
    lifecycle === null
      ? await persistOrdinaryMessage(params, idempotentId)
      : await persistToolLifecycleMessage(params, lifecycle);
  if (!result.created) {
    logUncreatedMessageWrite(params, result.message);
    return result.message;
  }
  broadcastCreatedMessage(params, result.message);
  return result.message;
}
