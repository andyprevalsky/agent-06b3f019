/**
 * Breadcrumb helpers shared by the agent-tree node view and search
 * (agentTreeService.ts, agentTreeSearch.ts): ancestor loading (one primary-key
 * query per level, MAX_ANCESTOR_LEVELS cap) and root→row paths.
 */

import { agentTaskPath } from './agentTaskPath';
import * as repo from './repoAgentTree';

const MAX_ANCESTOR_LEVELS = 64;

export type Row = repo.TreeNodeRow;

export interface TreePathEntry {
  agent_id: string;
  /** Task path ("/root/outreach/draft_a"); null for agents created before paths. */
  path: string | null;
  goal: string;
  status: string;
  depth: number;
}

/** Load every missing ancestor of `starts` into `known`, one PK query per level. */
export async function loadAncestors(starts: Row[], known: Map<string, Row>): Promise<void> {
  for (const row of starts) known.set(row.id, row);
  const missingParents = (rows: Row[]) => [
    ...new Set(
      rows
        .map((row) => row.parentAgentId)
        .filter((id): id is string => id !== null && !known.has(id))
    ),
  ];
  let frontier = missingParents(starts);
  for (let level = 0; level < MAX_ANCESTOR_LEVELS && frontier.length > 0; level += 1) {
    const rows = await repo.findTreeNodesByIds(frontier);
    for (const row of rows) known.set(row.id, row);
    frontier = missingParents(rows);
  }
}

/** Rows root→`row` from the loaded ancestors (stops at a missing or cyclic parent). */
export function pathTo(row: Row, known: Map<string, Row>): Row[] {
  const chain: Row[] = [row];
  const seen = new Set([row.id]);
  let parentId = row.parentAgentId;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = known.get(parentId);
    if (parent === undefined) break;
    chain.unshift(parent);
    seen.add(parent.id);
    parentId = parent.parentAgentId;
  }
  return chain;
}

export function pathEntry(row: Row): TreePathEntry {
  return {
    agent_id: row.id,
    path: agentTaskPath(row),
    goal: row.goal.slice(0, repo.TREE_GOAL_MAX_CHARS),
    status: row.status,
    depth: row.depth,
  };
}
