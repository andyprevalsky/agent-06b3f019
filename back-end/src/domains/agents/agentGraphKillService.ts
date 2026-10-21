/** Descendant-only agent control; lifecycle mutation stays in the canonical kill path. */
import * as repo from './agentGraphKillRepo';
import { deleteAgentRecursive } from '../../providers/agentKill';
import { getTemporalClient } from '../../providers/temporal';
import { AgentGraphError, type GraphCaller } from './agentGraphService';

async function assertDescendant(caller: GraphCaller, targetId: string): Promise<void> {
  if (caller.self.kind !== 'agent')
    throw new AgentGraphError(403, 'Only Rose agents can stop descendants');
  if (targetId === caller.self.id) throw new AgentGraphError(403, 'An agent cannot stop itself');
  let current: string | null = targetId;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current) && seen.size < 64) {
    if (current === caller.self.id) return;
    seen.add(current);
    const row: { parentAgentId: string | null } | null = await repo.findKillParent(
      current,
      caller.userId
    );
    if (row === null) break;
    current = row.parentAgentId;
  }
  throw new AgentGraphError(404, 'Descendant agent not found');
}

async function subtree(
  targetId: string,
  userId: string
): Promise<Array<{ id: string; temporalWorkflowId: string | null }>> {
  const out: Array<{ id: string; temporalWorkflowId: string | null }> = [];
  let pending = [targetId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const rows = await repo.findKillRows(pending, userId);
    for (const row of rows)
      if (!seen.has(row.id)) {
        seen.add(row.id);
        out.push(row);
      }
    const children = await repo.findKillChildren(pending, userId);
    pending = children.map((row) => row.id).filter((id) => !seen.has(id));
    if (out.length + pending.length > 10_000)
      throw new AgentGraphError(409, 'Subtree exceeds the stop-operation bound');
  }
  return out;
}

export async function killGraphAgent(caller: GraphCaller, targetId: string) {
  await assertDescendant(caller, targetId);
  await deleteAgentRecursive(targetId, {
    retryArchived: true,
    terminateReason: `Stopped by parent agent ${caller.self.id}`,
  });
  // Include archived rows: repeated calls must verify the original operation, not pretend an absent row proves cleanup.
  const rows = await subtree(targetId, caller.userId);
  const ids = rows.map((row) => row.id);
  const resources = await repo.countKillResources(ids);
  let running = 0;
  for (const row of rows) {
    if (row.temporalWorkflowId === null || row.temporalWorkflowId === '') continue;
    try {
      const client = await getTemporalClient();
      const description = await client.workflow.getHandle(row.temporalWorkflowId).describe();
      if (description.status.name === 'RUNNING') running += 1;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'WorkflowNotFoundError') throw error;
    }
  }
  if (running > 0 || resources.some((count) => count > 0)) {
    throw new AgentGraphError(
      409,
      'Agent archived; workflow or session cleanup is still unconfirmed'
    );
  }
  const target = await repo.requireKillParent(targetId, caller.userId);
  const siblings = await repo.findKillSiblings(targetId, caller.userId, target.parentAgentId);
  const remaining = siblings.slice(0, 20);
  return {
    unchanged_siblings: remaining,
    siblings_truncated: siblings.length > 20,
    agent_id: targetId,
    status: 'stopped',
    descendants_including_target: ids.length,
    message: `Stopped and archived agent ${targetId} and ${Math.max(0, ids.length - 1)} descendant(s). No agents outside this subtree were targeted. Unchanged sibling agents: ${remaining.map((row) => `${row.id} (${row.status})`).join(', ') || 'none'}.`,
    affected_agent_ids: ids,
  };
}
