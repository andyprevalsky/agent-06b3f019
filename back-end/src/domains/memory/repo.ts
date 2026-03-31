import { prisma } from '../../providers/database';

export async function findMemoryByBusId(busId: string) {
  return prisma.sharedMemory.findUnique({
    where: { busId },
  });
}

export async function updateMemory(
  busId: string,
  content: string,
  contentHash: string,
  tokenCount: number
) {
  return prisma.sharedMemory.update({
    where: { busId },
    data: {
      content,
      contentHash,
      tokenCount,
    },
  });
}

export async function createMemory(
  busId: string,
  content: string,
  contentHash: string,
  tokenCount: number
) {
  return prisma.sharedMemory.create({
    data: {
      busId,
      content,
      contentHash,
      tokenCount,
    },
  });
}
