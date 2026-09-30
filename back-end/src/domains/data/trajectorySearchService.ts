/** User-scoped grep over prior agent trees. */

import { buildAgentTrajectoryMatch } from './format';
import { AgentNotFoundError } from './errors';
import * as repo from './repo';
import * as trajectoryRepo from './trajectoryRepo';
import {
  ArchivedTraceNotFoundError,
  indexArchivedTraceFromR2,
} from '../../providers/traceArchiveSearchIndex';
import { createLogger } from '../../providers/logger';
import type { GrepMatch, ValidatedGrepInput } from './types';

const log = createLogger('TrajectorySearch');
const negativeArchiveRoots = new Map<string, number>();
const lastArchiveRepairByUser = new Map<string, number>();
const NEGATIVE_CACHE_MS = 5 * 60_000;
const REPAIR_INTERVAL_MS = 60_000;
const CACHE_LIMIT = 1024;

function remember(cache: Map<string, number>, key: string, value: number): void {
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function allowArchiveRepair(userId: string, rootAgentId: string): boolean {
  const now = Date.now();
  const key = `${userId}:${rootAgentId}`;
  if ((negativeArchiveRoots.get(key) ?? 0) > now) return false;
  if (now - (lastArchiveRepairByUser.get(userId) ?? 0) < REPAIR_INTERVAL_MS) return false;
  // One explicit-path R2 repair per user per minute bounds uncached probes.
  remember(lastArchiveRepairByUser, userId, now);
  return true;
}

export async function searchTrajectorySource(
  userId: string,
  input: ValidatedGrepInput,
  agentId: string | undefined
): Promise<{ total: number; matches: GrepMatch[] }> {
  let excludeRootAgentId: string | undefined;
  if (agentId !== undefined && agentId !== '') {
    const agent = await repo.findAgentByIdAndUser(agentId, userId);
    if (agent === null) throw new AgentNotFoundError(agentId);
    excludeRootAgentId = await repo.findRootAgentId(agentId, userId);
  }
  const pathRoot = input.filters.agentTrajectories?.pathRootAgentId;
  if (
    pathRoot !== undefined &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(pathRoot) &&
    !(await trajectoryRepo.hasTrajectoryRoot(userId, pathRoot)) &&
    allowArchiveRepair(userId, pathRoot)
  ) {
    const cacheKey = `${userId}:${pathRoot}`;
    try {
      const count = await indexArchivedTraceFromR2(pathRoot, userId);
      if (count === 0) remember(negativeArchiveRoots, cacheKey, Date.now() + NEGATIVE_CACHE_MS);
    } catch (error) {
      remember(negativeArchiveRoots, cacheKey, Date.now() + NEGATIVE_CACHE_MS);
      if (!(error instanceof ArchivedTraceNotFoundError)) {
        log.warn('Explicit-path archive repair failed; searching indexed rows', {
          root_agent_id: pathRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const query = {
    userId,
    excludeRootAgentId,
    pattern: input.dbPattern,
    caseInsensitive: input.caseInsensitive,
    filters: input.filters.agentTrajectories,
  };
  const [total, rows] = await Promise.all([
    trajectoryRepo.countAgentTrajectories(query),
    trajectoryRepo.searchAgentTrajectories({
      ...query,
      limit: input.headLimit,
      offset: input.offset,
    }),
  ]);
  return { total, matches: rows.map((row) => buildAgentTrajectoryMatch(row, input)) };
}
