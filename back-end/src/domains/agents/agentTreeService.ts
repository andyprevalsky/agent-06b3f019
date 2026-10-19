/**
 * Navigable agent-tree view (GET /api/agents/:id/tree): a table of contents
 * the calling agent drills into instead of one flat dump of the whole tree.
 *
 *   caller ──▶ resolve node (default = caller; must share caller's root + owner)
 *                │
 *                ├─ q? ──▶ goal search in this tree (LIMIT) + ancestor breadcrumbs
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
import { ROOT_TASK_PATH, agentTaskPath, rootOf } from './agentTaskPath';
import { resolveTreeAddress } from './agentAddressResolver';
import { backgroundTaskNodes, type BackgroundTaskNode } from './agentTreeBackgroundTasks';
import type { AgentTreeQuery } from './types';
import * as repo from './repoAgentTree';

const MAX_ANCESTOR_LEVELS = 64;
export const MAX_TREE_NODES = 150;

type Row = repo.TreeNodeRow;
type ServiceError = { error: string; status: number };

export interface TreePathEntry {
  agent_id: string;
  /** Task path ("/root/outreach/draft_a"); null for agents created before paths. */
  path: string | null;
  goal: string;
  status: string;
  depth: number;
}

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

export interface TreeMatch extends TreePathEntry {
  /** Ancestor agent ids root→parent (breadcrumb, also for path-less agents). */
  ancestor_ids: string[];
  child_count: number;
  active_child_count: number;
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

/** Load every missing ancestor of `starts` into `known`, one PK query per level. */
async function loadAncestors(starts: Row[], known: Map<string, Row>): Promise<void> {
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
function pathTo(row: Row, known: Map<string, Row>): Row[] {
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

function pathEntry(row: Row): TreePathEntry {
  return {
    agent_id: row.id,
    path: agentTaskPath(row),
    goal: row.goal.slice(0, repo.TREE_GOAL_MAX_CHARS),
    status: row.status,
    depth: row.depth,
  };
}

function byDepthThenAge(a: Row, b: Row): number {
  return (
    a.depth - b.depth ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** `node` is any address (path, "parent", "/root", agent id) in the caller's tree. */
async function resolveNode(caller: Row, address: string | undefined): Promise<Row | ServiceError> {
  if (address === undefined || address === caller.id) return caller;
  const resolved = await resolveTreeAddress(caller, address);
  if ('error' in resolved) return resolved;
  if (resolved.recipient_task_id !== null) {
    return {
      error: `${address} is a background task (no children); message it with send_message_to_agent`,
      status: 400,
    };
  }
  if (resolved.agent_id === caller.id) return caller;
  const [node] = await repo.findTreeNodesByIds([resolved.agent_id]);
  return node ?? { error: `No agent at ${address}`, status: 404 };
}

async function searchMatches(
  rootAgentId: string,
  ownerId: string,
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
  const rows = await repo.searchTreeByGoal(rootAgentId, ownerId, tokens, query.limit, prefix);
  await loadAncestors(rows, known);
  const counts = await repo.countDirectChildren(
    rows.map((row) => row.id),
    ownerId,
    TERMINAL_STATUSES
  );
  return rows.map((row) => ({
    ...pathEntry(row),
    ancestor_ids: pathTo(row, known)
      .slice(0, -1)
      .map((ancestor) => ancestor.id),
    child_count: counts.get(row.id)?.total ?? 0,
    active_child_count: counts.get(row.id)?.active ?? 0,
  }));
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
  const node = await resolveNode(caller, query.node);
  if ('error' in node) return node;
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
    const matches = await searchMatches(rootAgentId, caller.userId, query, known);
    return { ...base, nodes: [], next_cursor: null, sibling_next_cursor: null, matches };
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
