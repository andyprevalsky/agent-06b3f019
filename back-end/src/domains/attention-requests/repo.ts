import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { CreateAttentionRequestInput } from './types';

export async function create(data: CreateAttentionRequestInput) {
  return prisma.agentAttentionRequest.create({
    data: {
      userId: data.userId,
      agentId: data.agentId,
      workflowId: data.workflowId,
      question: data.question,
      imageUrl: data.imageUrl,
      metadata: data.metadata,
      gateKey: data.gateKey,
    },
  });
}

/**
 * Find the single PENDING (unanswered) request for a (userId, gateKey) gate, if
 * any. Used to fan multiple agents in onto one gate instead of duplicating it.
 */
export async function findPendingByGateKey(userId: string, gateKey: string) {
  return prisma.agentAttentionRequest.findFirst({
    where: { userId, gateKey, userResponse: null },
    orderBy: { createdAt: 'asc' },
  });
}

/** Overwrite the metadata blob (used to append gate waiters on dedup). */
export async function updateMetadata(id: string, metadata: Prisma.InputJsonValue) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { metadata },
  });
}

/** Source of the agent that raised a request (SMS agents get a gate SMS). */
export async function findAgentSource(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { source: true },
  });
}

/** The user's phone number, if any (for dispatching a gate SMS). */
export async function findUserPhone(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { phone: true },
  });
  return user?.phone ?? null;
}

export async function findById(id: string) {
  return prisma.agentAttentionRequest.findUnique({
    where: { id },
    include: {
      authAssistance: {
        select: { id: true },
      },
    },
  });
}

export async function findManyByUserId(userId: string) {
  return prisma.agentAttentionRequest.findMany({
    where: { userId },
    orderBy: { updatedAt: 'asc' },
  });
}

export async function countUnanswered(userId: string) {
  return prisma.agentAttentionRequest.count({
    where: { userId, userResponse: null },
  });
}

export async function updateResponse(id: string, userResponse: string) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { userResponse },
  });
}

export async function touchUpdatedAt(id: string) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { updatedAt: new Date() },
  });
}
