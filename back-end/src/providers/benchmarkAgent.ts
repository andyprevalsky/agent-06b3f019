import { prisma } from './database';

/** Whether the durable agent record belongs to the benchmark/eval harness. */
export async function isBenchmarkAgent(agentId: string | null | undefined): Promise<boolean> {
  if (agentId === undefined || agentId === null || agentId.trim() === '') return false;
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { isBenchmark: true },
  });
  return agent?.isBenchmark === true;
}
