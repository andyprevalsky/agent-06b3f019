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
import { retryWithBackoff } from './retry';
import {
  type ArchiveScope,
  assertBoundArchiveId,
  isBoundArchiveId,
  userArchiveRoot,
} from './llmArchiveRecord';

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
  // Only a walk that reaches a real root (busId, or a row with no parent) is
  // cached; a depth-limited, missing-ancestor or cyclic walk returns its best
  // ancestor for this call but is re-resolved next time.
  let reachedRoot = false;
  const visited = new Set<string>([agentId]);
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
      reachedRoot = true;
      break;
    }
    if (typeof row.parentAgentId !== 'string' || row.parentAgentId === '') {
      reachedRoot = true;
      break;
    }
    if (visited.has(row.parentAgentId)) break;
    visited.add(row.parentAgentId);
    current = row.parentAgentId;
  }
  if (reachedRoot) remember(agentId, current);
  else log.warn('archive.root_walk_incomplete', { agent_id: agentId, best_ancestor: current });
  return current;
}

/** Test seam: forget cached roots. */
export function __resetArchiveRootCache(): void {
  roots.clear();
  unknown.clear();
}

const ROOT_LOOKUP_ATTEMPTS = 3;
const ROOT_LOOKUP_BACKOFF_MS = 250;

/**
 * A failed lookup is retried (bounded backoff); after the last failure the
 * binding REJECTS, so the background archive task fails loudly instead of
 * filing the record under an unverified root (the acting agent id).
 */
async function resolveRootWithRetry(agentId: string): Promise<string> {
  try {
    return await retryWithBackoff(() => resolveArchiveRoot(agentId), {
      maxRetries: ROOT_LOOKUP_ATTEMPTS,
      initialBackoffMs: ROOT_LOOKUP_BACKOFF_MS,
      isRetryable: () => true,
      component: 'ArchiveRoot',
    });
  } catch (error) {
    log.error('archive.root_resolution_failed', {
      agent_id: agentId,
      attempts: ROOT_LOOKUP_ATTEMPTS,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * dump_context binding for a backend LLM call: the acting agent and its tree
 * root, or — for user-level work with no agent tree — the documented per-user
 * root `user-<userId>` (agent_id defaults to that root). Null only when neither
 * is known; the archive writer then refuses the record loudly. Rejects when the
 * agent's root cannot be verified (lookup kept failing after retries).
 */
export async function archiveBindingFor(
  params: ArchiveScope
): Promise<{ agent_id: string; root_agent_id: string } | null> {
  const { agentId, userId } = params;
  if (isBoundArchiveId(agentId)) {
    return { agent_id: agentId, root_agent_id: await resolveRootWithRetry(agentId) };
  }
  if (isBoundArchiveId(userId)) {
    const root = userArchiveRoot(userId);
    return { agent_id: params.userLevelAgentId ?? root, root_agent_id: root };
  }
  return null;
}

/**
 * The capture owners archiveBindingFor will bind, computed without I/O: the
 * record agent and the root known in memory (the agent itself until its tree
 * root resolves, or the per-user root). Null when the scope binds nothing.
 */
export function archiveScopeOwners(
  scope: ArchiveScope
): { agentId: string; ownerRoot: string } | null {
  if (isBoundArchiveId(scope.agentId)) return { agentId: scope.agentId, ownerRoot: scope.agentId };
  if (isBoundArchiveId(scope.userId)) {
    const root = userArchiveRoot(scope.userId);
    return { agentId: scope.userLevelAgentId ?? root, ownerRoot: root };
  }
  return null;
}
