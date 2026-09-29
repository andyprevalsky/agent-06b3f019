/** User-scoped grep over prior agent trees. */

import { buildAgentTrajectoryMatch } from './format';
import { AgentNotFoundError } from './errors';
import * as repo from './repo';
import * as trajectoryRepo from './trajectoryRepo';
import {
  ArchivedTraceNotFoundError,
  indexArchivedTraceFromR2,
} from '../../providers/traceArchiveSearchIndex';
import type { GrepMatch, ValidatedGrepInput } from './types';

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
    !(await trajectoryRepo.hasArchivedTrajectoryRoot(userId, pathRoot))
  ) {
    try {
      await indexArchivedTraceFromR2(pathRoot, userId);
    } catch (error) {
      if (!(error instanceof ArchivedTraceNotFoundError)) throw error;
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
