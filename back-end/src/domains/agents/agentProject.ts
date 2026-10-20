/**
 * Agent ↔ Project association (left-bar grouping, code-session workspace).
 *
 *   explicit project_id ──► must be owned by the caller (else 404)
 *   project_id: null    ──► Home (no project)
 *   omitted             ──► sub-agents inherit the parent's project; roots are Home
 *
 * 10k-agent behaviour: one PK/indexed lookup per create (batch: one query
 * for all explicit ids); the list API reads projectId from the same row.
 */
import type { CreateAgentBody } from './types';
import { findOwnedProjectIds, findParentProjectId } from './repoAgentProjects';

export class AgentProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'AgentProjectNotFoundError';
  }
}

export async function resolveAgentProjectId(
  body: CreateAgentBody,
  userId: string
): Promise<string | null> {
  if (body.project_id === null) return null;
  if (body.project_id !== undefined) {
    const owned = await findOwnedProjectIds([body.project_id], userId);
    if (owned.length !== 1) throw new AgentProjectNotFoundError();
    return body.project_id;
  }
  if (body.parent_agent_id === undefined) return null;
  return findParentProjectId(body.parent_agent_id, userId);
}

/**
 * Batch variant: validate every explicit id in one query, then fill omitted
 * ids from the already-loaded parent rows. Mutates `body.project_id`.
 */
export async function resolveBatchProjectIds(
  bodies: CreateAgentBody[],
  userId: string,
  parentById: Map<string, { projectId: string | null }>
): Promise<void> {
  const explicit = [
    ...new Set(
      bodies.map((body) => body.project_id).filter((id): id is string => typeof id === 'string')
    ),
  ];
  const owned = new Set(await findOwnedProjectIds(explicit, userId));
  for (const body of bodies) {
    if (typeof body.project_id === 'string') {
      if (!owned.has(body.project_id)) throw new AgentProjectNotFoundError();
      continue;
    }
    if (body.project_id === null || body.parent_agent_id === undefined) continue;
    const inherited = parentById.get(body.parent_agent_id)?.projectId ?? null;
    if (inherited !== null) body.project_id = inherited;
  }
}
