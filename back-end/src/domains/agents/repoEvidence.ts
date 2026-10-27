import { prisma } from '../../providers/database';

/** Bounded recovery read for one explore task after its activity is cancelled. */
export async function findExploreToolEvidence(agentId: string, userId: string, taskId: string) {
  const where = {
    agentId,
    agent: { userId },
    role: 'TOOL' as const,
    AND: [
      { metadata: { path: ['taskId'], equals: taskId } },
      { metadata: { path: ['toolStatus'], equals: 'FINISHED' } },
    ],
    NOT: { metadata: { path: ['toolName'], equals: 'spawn_agent' } },
  };
  const select = { id: true, text: true, metadata: true } as const;
  const [first, last] = await Promise.all([
    prisma.message.findMany({ where, orderBy: { timestamp: 'asc' }, take: 8, select }),
    prisma.message.findMany({ where, orderBy: { timestamp: 'desc' }, take: 8, select }),
  ]);
  // Read at most 16 rows so failed fetches can be removed before selecting
  // early and late successful evidence.
  return [...new Map([...first, ...last.reverse()].map((row) => [row.id, row])).values()];
}
