import { prisma } from '../../providers/database';

export async function findAllTools() {
  return prisma.tool.findMany({
    select: {
      id: true,
      name: true,
      description: true,
    },
    orderBy: {
      name: 'asc',
    },
  });
}
