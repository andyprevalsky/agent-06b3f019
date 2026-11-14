/**
 * True archive root for an agent id: `busId ?? id` (agentTaskPath.rootOf), with
 * a bounded parentAgentId walk for legacy rows that predate busId.
 *
 *   worker POST /api/archive/artifact(s) { rootAgentId: <maybe a child id> }
 *        │
 *        ▼
 *   resolveArchiveRoot(id) ── cache hit ──► root
 *        │ miss
 *        ▼
 *   one PK read (busId, parentAgentId) [+ ≤8 PK reads for legacy chains] ──► cache
 *
 * busId never changes after creation, so positive results are cached for the
 * process lifetime in a bounded LRU. 10k-agent cost: one indexed primary-key
 * read per (agent, backend instance) on its first archive write; ~100 B of
 * memory per cached agent (50k entries ≈ 5 MB). No per-call fan-out, no
 * shared lock or row. Unknown ids (purged agents, documented per-user roots)
 * are returned unchanged and negatively cached briefly.
 */

import { prisma } from './database';
import { createLogger } from './logger';
import { assertBoundArchiveId, isBoundArchiveId, userArchiveRoot } from './llmArchiveRecord';

const log = createLogger('ArchiveRoot');

const MAX_CACHED_ROOTS = 50_000;
const NEGATIVE_TTL_MS = 60_000;
const MAX_PARENT_WALK = 8;

const roots = new Map<string, string>();
const unknown = new Map<string, number>();

function remember(agentId: string, rootAgentId: string): void {
  roots.delete(agentId);
  roots.set(agentId, rootAgentId);
  if (roots.size > MAX_CACHED_ROOTS) {
    const oldest = roots.keys().next().value;
    if (oldest !== undefined) roots.delete(oldest);
  }
}

/** Documented non-agent roots (`user-<userId>`) are already roots. */
export function isSyntheticArchiveRoot(id: string): boolean {
  return id.startsWith('user-');
}

export async function resolveArchiveRoot(agentId: string): Promise<string> {
  assertBoundArchiveId('rootAgentId', agentId);
  if (isSyntheticArchiveRoot(agentId)) return agentId;
  const cached = roots.get(agentId);
  if (cached !== undefined) {
    remember(agentId, cached);
    return cached;
  }
  const missAt = unknown.get(agentId);
  if (missAt !== undefined && Date.now() - missAt < NEGATIVE_TTL_MS) return agentId;

  let current = agentId;
  for (let depth = 0; depth <= MAX_PARENT_WALK; depth += 1) {
    const row = await prisma.agent.findUnique({
      where: { id: current },
      select: { busId: true, parentAgentId: true },
    });
    if (row === null) {
      if (current === agentId) {
        unknown.set(agentId, Date.now());
        if (unknown.size > MAX_CACHED_ROOTS) unknown.clear();
        return agentId;
      }
      break;
    }
    if (typeof row.busId === 'string' && row.busId !== '') {
      current = row.busId;
      break;
    }
    if (typeof row.parentAgentId !== 'string' || row.parentAgentId === '') break;
    current = row.parentAgentId;
  }
  remember(agentId, current);
  return current;
}

/** Test seam: forget cached roots. */
export function __resetArchiveRootCache(): void {
  roots.clear();
  unknown.clear();
}

/**
 * dump_context binding for a backend LLM call: the acting agent and its tree
 * root, or — for user-level work with no agent tree — the documented per-user
 * root `user-<userId>` (agent_id defaults to that root). Null only when neither
 * is known; the archive writer then refuses the record loudly.
 */
export async function archiveBindingFor(params: {
  agentId?: string | null;
  userId?: string | null;
  /** Record agent_id for user-level calls (e.g. `sms-supervisor-<userId>`). */
  userLevelAgentId?: string;
}): Promise<{ agent_id: string; root_agent_id: string } | null> {
  const { agentId, userId } = params;
  if (isBoundArchiveId(agentId)) {
    try {
      return { agent_id: agentId, root_agent_id: await resolveArchiveRoot(agentId) };
    } catch (error) {
      log.error('archive.root_resolution_failed', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { agent_id: agentId, root_agent_id: agentId };
    }
  }
  if (isBoundArchiveId(userId)) {
    const root = userArchiveRoot(userId);
    return { agent_id: params.userLevelAgentId ?? root, root_agent_id: root };
  }
  return null;
}
