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
    select: { deletedAt: true, goal: true, isBenchmark: true },
  });
}
