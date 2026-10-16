import { prisma } from '../../providers/database';

/**
 * Fetch agent notification context.
 * Returns { deletedAt, goal, isBenchmark } or null if not found.
 *
 * `isBenchmark` lets the dispatcher suppress outbound SMS for benchmark/eval
 * runs. Those run under a real operator phone (e.g. Andy's), so without this
 * gate every benchmark root agent would text the operator — see
 * dispatchNotification's benchmark short-circuit.
 */
export async function findAgentDeletedStatus(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { deletedAt: true, goal: true, isBenchmark: true, source: true },
  });
}

/** Read the kickoff text saved with the initial goal, using the agent/timestamp index. */
export async function findAgentStartNotification(agentId: string): Promise<string | undefined> {
  const message = await prisma.message.findFirst({
    where: { agentId, role: 'USER', text: { not: '' } },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
  const metadata = message?.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
    return undefined;
  const notification = metadata.startNotification;
  if (notification === null || typeof notification !== 'object' || Array.isArray(notification))
    return undefined;
  return typeof notification.message === 'string' ? notification.message : undefined;
}
