/**
 * Navigable agent-tree view (GET /api/agents/:id/tree): a table of contents
 * the calling agent drills into instead of one flat dump of the whole tree.
 *
 *   caller ──▶ resolve node (default = caller; must share caller's root + owner)
 *                │
 *                ├─ q / path_prefix? ──▶ goal/path search in this tree (LIMIT) +
 *                │    ancestor breadcrumbs; the loaded agents' background tasks
 *                │    match too, so search covers what the node view lists
 *                │
 *                └─ node view: node + `depth` levels of children (`limit` per node,
 *                   keyset `cursor` over node's direct children) and, for the
 *                   caller's own first page, its ancestors + first page of siblings
 *                   (sibling_next_cursor pages the parent's children)
 *                   → direct-child counts (total / active) for every listed row
 *                   → each listed agent's in-flight background tasks as leaf
 *                     nodes `<owner>/<task>` (agentTreeBackgroundTasks.ts)
 *
 * 10k agents in one tree: the response is bounded by MAX_TREE_NODES rows and
 * every read is indexed and LIMITed (see repoAgentTree.ts). Ancestor walks are
 * one primary-key query per level (MAX_ANCESTOR_LEVELS cap), child pages are
 * (parentAgentId, createdAt) keyset reads, counts cover direct children of the
 * listed rows only, and search reads one tree via the busId index. Nothing is
 * O(tree size) per call except the count of a listed node's direct children.
 */

import { TERMINAL_STATUSES } from './statusBroadcastWorkflowId';
import { rootOf } from './agentTaskPath';
import { resolveTreeAddress } from './agentAddressResolver';
import {
  backgroundTaskNodes,
  listedBackgroundTasks,
  type BackgroundTaskNode,
} from './agentTreeBackgroundTasks';
import { loadAncestors, pathEntry, pathTo, type Row, type TreePathEntry } from './agentTreePaths';
import { searchMatches, type TreeMatch } from './agentTreeSearch';
import type { AgentTreeQuery } from './types';
import * as repo from './repoAgentTree';

export type { TreeMatch, TreePathEntry };

export const MAX_TREE_NODES = 150;

type ServiceError = { error: string; status: number };

export interface TreeNode extends TreePathEntry {
  /** 'agent' for agents; explore/browser/code for background tasks (`<owner>/<task>`). */
  type: string;
  parent_agent_id: string | null;
  created_at: Date;
  child_count: number;
  active_child_count: number;
  /** Tools the agent is running now (the FE banner's toolsInUse). */
  tools_in_use: string[];
}

export interface AgentTreeView {
  root_agent_id: string;
  caller_path: TreePathEntry[];
  node_path: TreePathEntry[];
  nodes: Array<TreeNode | BackgroundTaskNode>;
  next_cursor: string | null;
  /** Caller view only: cursor for the caller's parent's next page of children. */
  sibling_next_cursor: string | null;
  matches?: TreeMatch[];
}

function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(cursor: string): repo.ChildCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed as unknown[];
    if (typeof iso !== 'string' || typeof id !== 'string' || id === '') return null;
    const createdAt = new Date(iso);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

function byDepthThenAge(a: Row, b: Row): number {
  return (
    a.depth - b.depth ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

interface ResolvedNode {
  row: Row;
  /** Set when the address names one of `row`'s background tasks (a leaf). */
  taskId: string | null;
}

/** `node` is any address (path, "parent", "/root", agent id, task) in the caller's tree. */
async function resolveNode(
  caller: Row,
  address: string | undefined
): Promise<ResolvedNode | ServiceError> {
  if (address === undefined || address === caller.id) return { row: caller, taskId: null };
  const resolved = await resolveTreeAddress(caller, address);
  if ('error' in resolved) return resolved;
  const taskId = resolved.recipient_task_id;
  if (resolved.agent_id === caller.id) return { row: caller, taskId };
  const [row] = await repo.findTreeNodesByIds([resolved.agent_id]);
  return row === undefined ? { error: `No agent at ${address}`, status: 404 } : { row, taskId };
}

/** A background task's view: breadcrumbs through its owner and the task alone (no children). */
function taskView(
  base: Pick<AgentTreeView, 'root_agent_id' | 'caller_path' | 'node_path'>,
  owner: Row,
  taskId: string,
  address: string
): AgentTreeView | ServiceError {
  const entries = listedBackgroundTasks(owner).filter((entry) => entry.address === taskId);
  const [task] = backgroundTaskNodes([{ ...owner, backgroundTasks: entries }]);
  if (task === undefined)
    return { error: `No agent or background task at ${address}`, status: 404 };
  const crumb: TreePathEntry = {
    agent_id: task.agent_id,
    path: task.path,
    goal: task.goal,
    status: task.status,
    depth: task.depth,
  };
  return {
    ...base,
    node_path: [...base.node_path, crumb],
    nodes: [task],
    next_cursor: null,
    sibling_next_cursor: null,
  };
}

interface Expansion {
  rows: Row[];
  nextCursor: string | null;
}

/** Node's keyset page plus deeper levels (first `limit` children each), within budget. */
async function expandNode(
  node: Row,
  ownerId: string,
  query: AgentTreeQuery,
  after: repo.ChildCursor | undefined,
  budget: number
): Promise<Expansion> {
  const page = await repo.findChildPage(node.id, ownerId, query.limit, after);
  const children = page.slice(0, Math.min(query.limit, budget));
  const nextCursor =
    page.length > children.length && children.length > 0
      ? encodeCursor(children[children.length - 1])
      : null;
  const rows = [...children];
  let frontier = children;
  for (let level = 2; level <= query.depth && frontier.length > 0; level += 1) {
    const remaining = budget - rows.length;
    if (remaining <= 0) break;
    const order = new Map(frontier.map((row, index) => [row.id, index]));
    const next = (await repo.findFirstChildrenOf([...order.keys()], ownerId, query.limit))
      .sort(
        (a, b) =>
          (order.get(a.parentAgentId ?? '') ?? 0) - (order.get(b.parentAgentId ?? '') ?? 0) ||
          byDepthThenAge(a, b)
      )
      .slice(0, remaining);
    rows.push(...next);
    frontier = next;
  }
  return { rows, nextCursor };
}

/** The caller's first page also shows its ancestors and its first page of siblings. */
async function callerContext(
  caller: Row,
  callerPath: Row[],
  ownerId: string,
  limit: number
): Promise<{ rows: Row[]; siblingCursor: string | null }> {
  const rows = callerPath.slice(0, -1);
  if (caller.parentAgentId === null) return { rows, siblingCursor: null };
  const page = await repo.findChildPage(caller.parentAgentId, ownerId, limit, undefined);
  const siblings = page.slice(0, limit);
  rows.push(...siblings);
  const siblingCursor =
    page.length > siblings.length ? encodeCursor(siblings[siblings.length - 1]) : null;
  return { rows, siblingCursor };
}

export async function getAgentTreeView(
  agentId: string,
  query: AgentTreeQuery,
  userId: string | undefined
): Promise<AgentTreeView | ServiceError> {
  const [caller] = await repo.findTreeNodesByIds([agentId]);
  if (caller === undefined || caller.deletedAt !== null) {
    return { error: 'Agent not found', status: 404 };
  }
  if (userId !== undefined && caller.userId !== userId) {
    return { error: 'Agent not found', status: 404 };
  }
  const resolved = await resolveNode(caller, query.node);
  if ('error' in resolved) return resolved;
  const node = resolved.row;
  const after = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
  if (after === null) return { error: 'Invalid cursor', status: 400 };

  const known = new Map<string, Row>();
  await loadAncestors([caller, node], known);
  const rootAgentId = rootOf(caller);
  const callerPath = pathTo(caller, known);
  const base = {
    root_agent_id: rootAgentId,
    caller_path: callerPath.map(pathEntry),
    node_path: pathTo(node, known).map(pathEntry),
  };
  if (query.q !== undefined || query.path_prefix !== undefined) {
    const matches = await searchMatches(caller, rootAgentId, query, known);
    return { ...base, nodes: [], next_cursor: null, sibling_next_cursor: null, matches };
  }
  if (resolved.taskId !== null) {
    return taskView(base, node, resolved.taskId, query.node ?? node.id);
  }

  const listed = new Map<string, Row>();
  let siblingCursor: string | null = null;
  if (node.id === caller.id && after === undefined) {
    const context = await callerContext(caller, callerPath, caller.userId, query.limit);
    for (const row of context.rows) listed.set(row.id, row);
    siblingCursor = context.siblingCursor;
  }
  listed.set(node.id, node);
  const expansion = await expandNode(
    node,
    caller.userId,
    query,
    after,
    MAX_TREE_NODES - listed.size
  );
  for (const row of expansion.rows) listed.set(row.id, row);

  const rows = [...listed.values()].sort(byDepthThenAge);
  const counts = await repo.countDirectChildren(
    rows.map((row) => row.id),
    caller.userId,
    TERMINAL_STATUSES
  );
  return {
    ...base,
    nodes: [
      ...rows.map((row) => ({
        ...pathEntry(row),
        type: 'agent',
        parent_agent_id: row.parentAgentId,
        created_at: row.createdAt,
        child_count: counts.get(row.id)?.total ?? 0,
        active_child_count: counts.get(row.id)?.active ?? 0,
        tools_in_use: row.toolsInUse,
      })),
      // A cursor page repeats the node row for context, not its tasks.
      ...backgroundTaskNodes(rows.filter((row) => after === undefined || row.id !== node.id)),
    ],
    next_cursor: expansion.nextCursor,
    sibling_next_cursor: siblingCursor,
  };
}
