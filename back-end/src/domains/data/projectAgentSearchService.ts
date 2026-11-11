/**
 * list_agents over projects: the reader's own projects plus projects teammates
 * explicitly shared with an accepted team. Metadata only: never goals,
 * trajectories, credentials or environment. Membership is re-checked per read.
 */
import { InvalidGrepParamError } from './errors';
import { listProjectAgentRows, type ProjectAgentQuery } from './projectAgentRepo';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function exactId(raw: unknown, key: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new InvalidGrepParamError(key, 'Expected an exact identifier.');
  }
  return raw.trim();
}

function count(raw: unknown, key: string, fallback: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new InvalidGrepParamError(key, `Expected an integer from 0 to ${max}.`);
  }
  return value;
}

export function parseProjectAgentQuery(raw: Record<string, unknown>): ProjectAgentQuery {
  const q = raw.q === undefined || raw.q === null ? undefined : raw.q;
  if (q !== undefined && typeof q !== 'string') {
    throw new InvalidGrepParamError('q', 'Expected text.');
  }
  return {
    q: q?.trim() === '' ? undefined : q?.trim(),
    projectId: exactId(raw.project_id, 'project_id'),
    ownerUserId: exactId(raw.owner_user_id, 'owner_user_id'),
    teamId: exactId(raw.team_id, 'team_id'),
    offset: count(raw.offset, 'offset', 0, 100_000),
    limit: Math.max(1, count(raw.limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT)),
  };
}

export async function listProjectAgents(userId: string, input: ProjectAgentQuery) {
  const { total, rows } = await listProjectAgentRows(userId, input);
  const next = input.offset + rows.length;
  return {
    total,
    next_offset: next < total ? next : null,
    agents: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      project_id: row.projectId,
      project_name: row.projectName,
      owner_user_id: row.ownerUserId,
      owner_name: row.ownerName,
      own: row.ownerUserId === userId,
      team_ids: row.teamIds,
      updated_at: row.updatedAt.toISOString(),
    })),
  };
}
