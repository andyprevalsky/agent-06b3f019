/** Shared message creation for API routes, workers, and chat handlers. */

import { Prisma, type Message } from '@prisma/client';
import { createHash } from 'node:crypto';
import { broadcastMessageInsert } from './chat/supabaseBroadcast';
import { prisma, runTransactionWithRetry } from './database';
import { createLogger } from './logger';
import {
  messageMetadata,
  metadataEquals,
  persistLockedToolLifecycleMessage,
  persistToolLifecycleMessage,
  stringMetadataValue,
  toolLifecycleIdentity,
} from './toolLifecycleMessages';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import { scheduleMessageGmvCapture } from './messageGmvCapture';
import { type CreateMessageParams, storableMessageParams, withoutNulJson } from './messageParams';

const log = createLogger('Messages');

export type { CreateMessageParams };

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
  idempotentId: string | null,
  tx?: Prisma.TransactionClient
): Promise<{ message: Message; created: boolean }> {
  const db = tx ?? prisma;
  const duplicate =
    params.skipDuplicateToolCheck === true
      ? null
      : tx === undefined
        ? await findDuplicateToolMessage(params)
        : await findDuplicateToolMessageInTransaction(tx, params);
  if (duplicate !== null) return { message: duplicate, created: false };
  try {
    const message = await db.message.create({
      data: {
        ...(idempotentId === null ? {} : { id: idempotentId }),
        agentId: params.agentId,
        workflowGeneration: params.workflowGeneration,
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
      const winner = await db.message.findUnique({ where: { id: idempotentId } });
      if (winner !== null) return { message: winner, created: false };
    }
    throw error;
  }
}

async function findDuplicateToolMessageInTransaction(
  tx: Prisma.TransactionClient,
  params: CreateMessageParams
): Promise<Message | null> {
  if (params.role !== 'TOOL' || (params.filePointer !== undefined && params.filePointer !== null)) {
    return null;
  }
  const toolCallId = stringMetadataValue(params.metadata, 'toolCallId');
  const toolStatus = stringMetadataValue(params.metadata, 'toolStatus');
  const title = stringMetadataValue(params.metadata, 'title');
  if (toolCallId === null || toolStatus === null) return null;
  const predicates: Prisma.MessageWhereInput[] = [
    { metadata: { path: ['toolCallId'], equals: toolCallId } },
    { metadata: { path: ['toolStatus'], equals: toolStatus } },
  ];
  if (title !== null) predicates.push({ metadata: { path: ['title'], equals: title } });
  const candidates = await tx.message.findMany({
    where: {
      agentId: params.agentId,
      role: 'TOOL',
      text: params.text,
      filePointer: { equals: Prisma.AnyNull },
      AND: predicates,
    },
    orderBy: { timestamp: 'desc' },
  });
  return (
    candidates.find((candidate) => metadataEquals(params.metadata, candidate.metadata)) ?? null
  );
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

export function broadcastCreatedMessage(params: CreateMessageParams, message: Message): void {
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

/** Persist authored input inside its owner's transaction; broadcast after commit. */
export async function createUserMessageInTransaction(
  tx: Prisma.TransactionClient,
  params: Pick<CreateMessageParams, 'agentId' | 'text' | 'metadata'>
): Promise<Message> {
  return (
    await persistOrdinaryMessage(storableMessageParams({ ...params, role: 'USER' }), null, tx)
  ).message;
}

/** Create, deduplicate, fence, persist, and broadcast one message. */
export async function createMessage(input: CreateMessageParams): Promise<Message> {
  const params = storableMessageParams(input);
  const idempotentId = idempotentMessageId(params);
  const idempotentDuplicate = await findIdempotentMessage(params);
  if (idempotentDuplicate !== null) return idempotentDuplicate;

  const lifecycle = toolLifecycleIdentity(params);
  const result =
    lifecycle === null
      ? await persistOrdinaryMessage(params, idempotentId)
      : await persistToolLifecycleMessage(params, lifecycle);
  if (!result.created) {
    if ('updated' in result && result.updated && params.skipBroadcast !== true)
      broadcastCreatedMessage(params, result.message);
    logUncreatedMessageWrite(params, result.message);
    return result.message;
  }
  if (params.skipBroadcast !== true) broadcastCreatedMessage(params, result.message);
  // Browser (and other tool) completions carry structured_response on the FINISHED
  // TOOL row — harvest paid-order GMV when amount + confirmation id are both present.
  scheduleMessageGmvCapture(params);
  return result.message;
}

export interface WorkflowMessageGroupResult {
  accepted: boolean;
  message: Message | null;
}

interface PersistedWorkflowMessage {
  message: Message;
  created: boolean;
  accepted: boolean;
  updated?: boolean;
}

interface PersistedWorkflowMessageGroup {
  accepted: boolean;
  main: PersistedWorkflowMessage | null;
  attachments: Array<{ message: Message; created: boolean }>;
}

async function persistWorkflowMessageGroup(
  tx: Prisma.TransactionClient,
  params: CreateMessageParams,
  attachments: Array<Record<string, unknown>>,
  workflowGeneration: string,
  idempotentId: string | null
): Promise<PersistedWorkflowMessageGroup> {
  const lifecycle = toolLifecycleIdentity(params);
  let main: PersistedWorkflowMessage;
  if (lifecycle !== null) {
    main = await persistLockedToolLifecycleMessage(tx, params, lifecycle);
  } else {
    await lockAgentWorkflowGeneration(tx, params.agentId);
    const agent = await tx.agent.findUnique({
      where: { id: params.agentId },
      select: { temporalWorkflowId: true },
    });
    const accepted =
      agent !== null &&
      (agent.temporalWorkflowId === workflowGeneration ||
        (agent.temporalWorkflowId === null && workflowGeneration === params.agentId));
    if (!accepted) return { accepted: false, main: null, attachments: [] };
    const duplicate =
      idempotentId === null ? null : await tx.message.findUnique({ where: { id: idempotentId } });
    const persisted =
      duplicate === null
        ? await persistOrdinaryMessage(params, idempotentId, tx)
        : { message: duplicate, created: false };
    main = { ...persisted, accepted: true };
  }
  if (!main.accepted) return { accepted: false, main, attachments: [] };
  // A retry whose main row exists already committed its attachments atomically.
  if (!main.created) return { accepted: true, main, attachments: [] };

  const createdAttachments: Array<{ message: Message; created: boolean }> = [];
  for (const filePointer of attachments) {
    createdAttachments.push(
      await persistOrdinaryMessage(
        {
          agentId: params.agentId,
          text: '',
          role: params.role,
          filePointer,
          workflowGeneration,
        },
        null,
        tx
      )
    );
  }
  return { accepted: true, main, attachments: createdAttachments };
}

function broadcastWorkflowMessageGroup(
  params: CreateMessageParams,
  result: PersistedWorkflowMessageGroup
): void {
  if (params.skipBroadcast === true) return;
  if (result.main !== null && (result.main.created || result.main.updated)) {
    broadcastCreatedMessage(params, result.main.message);
  }
  for (const attachment of result.attachments) {
    if (!attachment.created) continue;
    broadcastCreatedMessage(
      {
        agentId: params.agentId,
        text: '',
        role: params.role,
        filePointer: attachment.message.filePointer as object,
        workflowGeneration: params.workflowGeneration,
      },
      attachment.message
    );
  }
}

/**
 * Persist one internal workflow message and all of its attachment rows under the
 * same generation lock and database transaction. A cutover therefore sees the
 * complete group or none of it; external/user writes continue through
 * createMessage and are deliberately not generation-fenced.
 */
export async function createWorkflowMessageGroup(
  input: CreateMessageParams,
  inputAttachments: Array<Record<string, unknown>>,
  workflowGeneration: string
): Promise<WorkflowMessageGroupResult> {
  const params = storableMessageParams(input);
  const attachments = withoutNulJson(inputAttachments);
  const stampedParams: CreateMessageParams = {
    ...params,
    workflowGeneration,
    enforceCurrentWorkflowGeneration: true,
    ...(params.role === 'TOOL'
      ? {
          metadata: {
            ...params.metadata,
            workflowGeneration,
          },
        }
      : {}),
  };
  const idempotentId = idempotentMessageId(stampedParams);
  const result = await runTransactionWithRetry((tx) =>
    persistWorkflowMessageGroup(tx, stampedParams, attachments, workflowGeneration, idempotentId)
  );
  broadcastWorkflowMessageGroup(stampedParams, result);
  if (!result.accepted || result.main === null) {
    return { accepted: false, message: result.main?.message ?? null };
  }
  if (result.main.created) {
    scheduleMessageGmvCapture(stampedParams);
  }
  return { accepted: true, message: result.main.message };
}
