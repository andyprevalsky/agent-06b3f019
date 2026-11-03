/**
 * Agent-tree search (GET /api/agents/:id/tree with q / path_prefix): goal and
 * path matches in the caller's tree, shallowest first, with breadcrumbs.
 *
 * Search covers what the node view lists: agent rows whose goal/path match and
 * background tasks (explore/browser/code) whose goal/path match, found by the
 * same busId-scoped, LIMITed tree read. Tasks are filtered before the
 * per-owner/response caps apply, so a filter never hides an item the browse
 * view shows (2026-10-26-list-agents-search-omitted-background-tasks).
 *
 * 10k agents: two indexed tree queries (agent goals, task entries) each
 * LIMITed, plus the primary-key ancestor walk; nothing reads beyond one tree.
 */

import { TERMINAL_STATUSES } from './statusBroadcastWorkflowId';
import { ROOT_TASK_PATH } from './agentTaskPath';
import { backgroundTaskNodes } from './agentTreeBackgroundTasks';
import { loadAncestors, pathEntry, pathTo, type Row, type TreePathEntry } from './agentTreePaths';
import type { AgentTreeQuery } from './types';
import * as repo from './repoAgentTree';

export interface TreeMatch extends TreePathEntry {
  /** 'agent' for agents; explore/browser/code for background tasks (`<owner>/<task>`). */
  type: string;
  /** Ancestor agent ids root→parent (breadcrumb, also for path-less agents). */
  ancestor_ids: string[];
  child_count: number;
  active_child_count: number;
}

function matchesSearch(path: string, goal: string, prefix: string | null, tokens: string[]) {
  const lowered = goal.toLowerCase();
  return (
    (prefix === null || path === prefix || path.startsWith(`${prefix}/`)) &&
    tokens.every((token) => lowered.includes(token.toLowerCase()))
  );
}

export async function searchMatches(
  caller: Row,
  rootAgentId: string,
  query: AgentTreeQuery,
  known: Map<string, Row>
): Promise<TreeMatch[]> {
  const tokens = (query.q ?? '')
    .split(/\s+/)
    .filter((token) => token !== '')
    .slice(0, 8);
  const prefix =
    query.path_prefix === undefined || query.path_prefix === ROOT_TASK_PATH
      ? null
      : query.path_prefix.replace(/\/+$/, '');
  const [rows, taskOwnerRows] = await Promise.all([
    repo.searchTreeByGoal(rootAgentId, caller.userId, tokens, query.limit, prefix),
    repo.searchTreeTaskOwners(rootAgentId, caller.userId, tokens, query.limit, prefix),
  ]);
  await loadAncestors([...rows, ...taskOwnerRows], known);
  const counts = await repo.countDirectChildren(
    rows.map((row) => row.id),
    caller.userId,
    TERMINAL_STATUSES
  );
  const agentMatches: TreeMatch[] = rows.map((row) => ({
    ...pathEntry(row),
    type: 'agent',
    ancestor_ids: pathTo(row, known)
      .slice(0, -1)
      .map((ancestor) => ancestor.id),
    child_count: counts.get(row.id)?.total ?? 0,
    active_child_count: counts.get(row.id)?.active ?? 0,
  }));
  const taskMatches: TreeMatch[] = backgroundTaskNodes(taskOwnerRows, (address, entry) =>
    matchesSearch(address, entry.goal, prefix, tokens)
  ).map((task) => {
    const owner = known.get(task.parent_agent_id);
    return {
      agent_id: task.agent_id,
      path: task.path,
      goal: task.goal,
      status: task.status,
      depth: task.depth,
      type: task.type,
      ancestor_ids: owner === undefined ? [] : pathTo(owner, known).map((row) => row.id),
      child_count: 0,
      active_child_count: 0,
    };
  });
  // Shallowest first; within a depth, agents before tasks (stable sort).
  return [...agentMatches, ...taskMatches].sort((a, b) => a.depth - b.depth).slice(0, query.limit);
}
