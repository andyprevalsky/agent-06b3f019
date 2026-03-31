import { prisma } from '../../providers/database';

export async function findKeysByUserId(userId: string) {
  return prisma.roseApiKey.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      apiKey: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findSubscriptionByUserId(userId: string) {
  return prisma.subscription.findUnique({
    where: { userId },
  });
}

export async function createApiKey(userId: string, apiKey: string, name: string | null) {
  return prisma.roseApiKey.create({
    data: {
      userId,
      apiKey,
      name,
    },
  });
}

export async function findKeyByIdAndUserId(id: string, userId: string) {
  return prisma.roseApiKey.findFirst({
    where: { id, userId },
  });
}

export async function deleteKeyById(id: string) {
  return prisma.roseApiKey.delete({
    where: { id },
  });
}
