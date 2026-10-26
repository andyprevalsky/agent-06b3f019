/**
 * Agent-tree search (GET /api/agents/:id/tree with q / path_prefix): goal and
 * path matches in the caller's tree, shallowest first, with breadcrumbs.
 *
 * Search covers what the node view lists: agent rows (indexed goal/path query,
 * LIMITed) and the background tasks (explore/browser/code) of every agent the
 * search loaded — the matches, their ancestors, the caller path and the owner
 * a prefix resolves to. A filter must never hide an item the browse view
 * shows (2026-10-26-list-agents-search-omitted-background-tasks).
 *
 * 10k agents: one indexed tree query, one address resolve and at most one
 * primary-key read beyond the ancestor walk; tasks are read from rows already
 * loaded (backgroundTaskNodes caps them per owner and per response).
 */

import { TERMINAL_STATUSES } from './statusBroadcastWorkflowId';
import { ROOT_TASK_PATH, rootOf } from './agentTaskPath';
import { resolveTreeAddress } from './agentAddressResolver';
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
  const rows = await repo.searchTreeByGoal(rootAgentId, caller.userId, tokens, query.limit, prefix);
  // A prefix naming a background task (or an agent above the matches) loads its owner,
  // whose task list is then searched with the other loaded agents'.
  const prefixOwner = prefix === null ? null : await resolveTreeAddress(caller, prefix);
  const owners = [...rows];
  if (prefixOwner !== null && !('error' in prefixOwner)) {
    const ownerRow =
      known.get(prefixOwner.agent_id) ?? (await repo.findTreeNodesByIds([prefixOwner.agent_id]))[0];
    if (ownerRow !== undefined) owners.push(ownerRow);
  }
  await loadAncestors(owners, known);
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
  const taskOwners = [...known.values()].filter(
    (row) => row.deletedAt === null && row.userId === caller.userId && rootOf(row) === rootAgentId
  );
  const taskMatches: TreeMatch[] = backgroundTaskNodes(taskOwners)
    .filter((task) => matchesSearch(task.agent_id, task.goal, prefix, tokens))
    .map((task) => {
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
