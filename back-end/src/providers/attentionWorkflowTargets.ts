import type { Prisma } from '@prisma/client';

export class AttentionWorkflowTargetOwnershipError extends Error {}

export interface AttentionWorkflowTarget {
  agentId: string;
  workflowId: string;
}

// workflowReplacementState uses crypto.randomUUID() for these generation tokens.
const REPLACEMENT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validate both agent ownership and authoritative workflow identity before signaling. */
export async function assertAttentionWorkflowTargets(
  db: Pick<Prisma.TransactionClient, 'agent'>,
  userId: string,
  targets: AttentionWorkflowTarget[]
): Promise<void> {
  if (targets.length === 0) return;
  const agentIds = [...new Set(targets.map((target) => target.agentId))];
  const workflowIds = [...new Set(targets.map((target) => target.workflowId))];
  const agents = await db.agent.findMany({
    where: {
      OR: [
        { id: { in: [...new Set([...agentIds, ...workflowIds])] } },
        { temporalWorkflowId: { in: workflowIds } },
        { staleTemporalWorkflowId: { in: workflowIds } },
      ],
    },
    select: { id: true, userId: true, temporalWorkflowId: true, staleTemporalWorkflowId: true },
  });
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const workflowOwners = new Map<string, Set<string>>();
  for (const agent of agents) {
    for (const workflowId of [agent.id, agent.temporalWorkflowId, agent.staleTemporalWorkflowId]) {
      if (workflowId === null) continue;
      const owners = workflowOwners.get(workflowId) ?? new Set<string>();
      owners.add(agent.id);
      workflowOwners.set(workflowId, owners);
    }
  }
  for (const target of targets) {
    const agent = byId.get(target.agentId);
    const prefix = `${target.agentId}:replacement:`;
    const knownReplacement =
      target.workflowId.startsWith(prefix) &&
      REPLACEMENT_TOKEN.test(target.workflowId.slice(prefix.length));
    const conflictingOwner = [...(workflowOwners.get(target.workflowId) ?? [])].some(
      (agentId) => agentId !== target.agentId
    );
    if (
      agent === undefined ||
      agent.userId !== userId ||
      conflictingOwner ||
      !(
        target.workflowId === agent.id ||
        target.workflowId === agent.temporalWorkflowId ||
        target.workflowId === agent.staleTemporalWorkflowId ||
        knownReplacement
      )
    ) {
      throw new AttentionWorkflowTargetOwnershipError(
        'Attention workflows must belong to their target agent and request owner'
      );
    }
  }
}
