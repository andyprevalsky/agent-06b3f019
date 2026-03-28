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
    },
  });
}

export async function findById(id: string) {
  return prisma.agentAttentionRequest.findUnique({
    where: { id },
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
