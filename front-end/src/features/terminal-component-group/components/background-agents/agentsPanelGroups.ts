/**
 * Pure model for the query-box agents banner, shaped for the existing
 * SubAgentTree renderers (TreeHeader + TreeNodeRow): every agent is a
 * TreeNode, and `getChildren` drives the same recursive tree the for_each UI
 * always used.
 *
 * Inputs (all already subscribed elsewhere — no new channels):
 *   - tree nodes from the per-root `bus:<busId>` subscription (useAgentTree)
 *   - background spawns derived from the selected agent's own rows
 *   - optional `backgroundTasks` on each tree node (in-activity tasks)
 *
 * In-activity explore/browser/code tasks have no Agent row; they become
 * synthetic TreeNodes (`task:<address>`, never navigable) so they render with
 * the same circle/progress/status language.
 *
 * 10k-agent note: each build indexes `parentAgentId → children` in one pass
 * over the bus tree; counts, for_each totals and every rendered row then look
 * children up (memoized per parent), so a realtime rebuild is O(nodes).
 */
import { indexTreeChildren, type TreeNode, type TreeBackgroundTask } from '../../hooks';
import { agentPathShortName, type BackgroundSpawn } from '../../hooks/backgroundSpawns';
import { makePendingNode, isTerminalNode } from '../subAgentTree.helpers';
import { singleLine } from './backgroundAgentLabels';

export const TASK_NODE_PREFIX = 'task:';

export interface PanelGroupHeader {
  circle: string;
  title: string;
  totalAgents: number;
  allTerminal: boolean;
  anyFailed: boolean;
}

export interface PanelGroup {
  key: string;
  /** for_each groups get the SubAgentTree cluster header; plain children don't. */
  header: PanelGroupHeader | null;
  roots: TreeNode[];
}

export interface PanelCounts {
  total: number;
  running: number;
}

export interface AgentPanelModel {
  groups: PanelGroup[];
  getChildren: (parentId: string) => TreeNode[];
  counts: PanelCounts;
}

const IN_ACTIVITY_TYPES = new Set(['explore', 'browser', 'code']);
const FAILED_TASK = new Set(['failed', 'error', 'cancelled', 'canceled', 'timeout']);
const DONE_TASK = new Set(['completed', 'complete', 'done', 'finished', 'success']);

export function isRunningNode(node: TreeNode): boolean {
  return node.status === 'STARTING_UP' || node.status === 'ACTIVE';
}

export function isTaskNodeId(agentId: string): boolean {
  return agentId.startsWith(TASK_NODE_PREFIX);
}

function taskStatus(status: string): TreeNode['status'] {
  const normalized = status.toLowerCase();
  // A user pause ended the run: resumable, not running and not failed.
  if (normalized === 'paused') return 'PAUSED';
  if (FAILED_TASK.has(normalized)) return 'FAILED';
  if (DONE_TASK.has(normalized)) return 'COMPLETED';
  return 'ACTIVE';
}

/** A background explore/browser/code task as a TreeNode for the shared renderers. */
export function taskTreeNode(args: {
  address: string;
  parentAgentId: string;
  type: string;
  goal: string;
  path: string | null;
  status: TreeNode['status'];
  activity: string | null;
}): TreeNode {
  const label = agentPathShortName(args.path) ?? singleLine(args.goal);
  return {
    // A task's identity is its address (task path, else its id), as on the
    // backend tree; Agent.backgroundTasks' `address` is the current run's inbox.
    agentId: `${TASK_NODE_PREFIX}${args.path ?? args.address}`,
    parentAgentId: args.parentAgentId,
    goal: `${args.type} · ${label || args.address}`,
    status: args.status,
    progress: 0,
    toolsInUse: args.activity ? [args.activity] : [],
    messageCount: 1,
    costCents: 0,
    taskPath: args.path ?? undefined,
  };
}

function fromTreeTask(task: TreeBackgroundTask, parentAgentId: string): TreeNode {
  return taskTreeNode({
    address: task.address,
    parentAgentId,
    type: task.type,
    goal: task.goal,
    path: task.path ?? (task.address.startsWith('/') ? task.address : null),
    status: taskStatus(task.status),
    activity: null,
  });
}

const SPAWN_NODE_STATUS: Record<BackgroundSpawn['state'], TreeNode['status']> = {
  running: 'ACTIVE',
  completed: 'COMPLETED',
  failed: 'FAILED',
  paused: 'PAUSED',
};

function fromSpawn(spawn: BackgroundSpawn, parentAgentId: string): TreeNode {
  const status = SPAWN_NODE_STATUS[spawn.state];
  return taskTreeNode({
    address: spawn.address ?? spawn.ownerToolCallId,
    parentAgentId,
    type: spawn.agentType,
    goal: spawn.goal,
    path: spawn.path,
    status,
    activity: spawn.state === 'running' ? spawn.activity : null,
  });
}

/** SubAgentTree cluster glyph: ● all done, ✗ any failed when done, ◑ running. */
export function clusterCircle(nodes: TreeNode[]): string {
  const allTerminal = nodes.length > 0 && nodes.every(isTerminalNode);
  if (!allTerminal) return '◑';
  return nodes.some((n) => n.status === 'FAILED') ? '✗' : '●';
}

function forEachHeader(spawn: BackgroundSpawn, roots: TreeNode[], total: number) {
  const allTerminal = roots.length > 0 && roots.every(isTerminalNode);
  const name = agentPathShortName(spawn.path) ?? singleLine(spawn.goal);
  return {
    circle: clusterCircle(roots),
    title: name ? `for_each · ${name}` : 'for_each',
    totalAgents: total,
    allTerminal,
    anyFailed: roots.some((n) => n.status === 'FAILED'),
  };
}

function withSpawnGoal(node: TreeNode | undefined, id: string, parent: string, goal: string) {
  if (node) return node.goal ? node : { ...node, goal };
  return { ...makePendingNode(id), parentAgentId: parent, goal };
}

function countAll(groups: PanelGroup[], getChildren: (id: string) => TreeNode[]): PanelCounts {
  let total = 0;
  let running = 0;
  const seen = new Set<string>();
  const walk = (node: TreeNode) => {
    if (seen.has(node.agentId)) return;
    seen.add(node.agentId);
    total += 1;
    if (isRunningNode(node)) running += 1;
    getChildren(node.agentId).forEach(walk);
  };
  groups.forEach((group) => group.roots.forEach(walk));
  return { total, running };
}

function runningFirst(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => Number(isRunningNode(b)) - Number(isRunningNode(a)));
}

/** Real tree nodes under (and including) `rootIds` — filterTreeBySpawn's count, via the index. */
function subtreeSize(
  nodes: ReadonlyMap<string, TreeNode>,
  childIndex: ReadonlyMap<string, TreeNode[]>,
  rootIds: string[],
): number {
  const seen = new Set<string>();
  const stack = rootIds.filter((id) => nodes.has(id));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of childIndex.get(id) ?? []) stack.push(child.agentId);
  }
  return seen.size;
}

interface BuildArgs {
  nodes: ReadonlyMap<string, TreeNode>;
  selectedAgentId: string;
  spawns: BackgroundSpawn[];
}

/** Descendant hierarchy of the selected agent (all depths) + its background tasks. */
export function buildAgentPanelModel({
  nodes,
  selectedAgentId,
  spawns,
}: BuildArgs): AgentPanelModel {
  const childIndex = indexTreeChildren(nodes.values());
  const childCache = new Map<string, TreeNode[]>();
  // The selected agent's own spawn rows list its tasks (with live activity);
  // its persisted copy of the same task is not a second row.
  const ownTaskIds = new Set(
    spawns
      .filter((spawn) => IN_ACTIVITY_TYPES.has(spawn.agentType))
      .map((spawn) => fromSpawn(spawn, selectedAgentId).agentId),
  );
  const getChildren = (parentId: string): TreeNode[] => {
    const cached = childCache.get(parentId);
    if (cached) return cached;
    const kids = childIndex.get(parentId) ?? [];
    const tasks = (nodes.get(parentId)?.backgroundTasks ?? [])
      .filter((task) => !nodes.has(task.address))
      .map((task) => fromTreeTask(task, parentId))
      .filter((task) => parentId !== selectedAgentId || !ownTaskIds.has(task.agentId));
    const children = runningFirst([...kids, ...tasks]);
    childCache.set(parentId, children);
    return children;
  };
  const claimed = new Set<string>();
  const groups: PanelGroup[] = [];
  for (const spawn of spawns.filter((s) => s.agentType === 'for_each')) {
    const roots = spawn.subAgentIds.map((id) =>
      withSpawnGoal(nodes.get(id), id, selectedAgentId, spawn.goal),
    );
    roots.forEach((root) => claimed.add(root.agentId));
    const total = Math.max(subtreeSize(nodes, childIndex, spawn.subAgentIds), roots.length);
    groups.push({
      key: `for_each:${spawn.ownerToolCallId}`,
      header: forEachHeader(spawn, roots, total),
      roots: runningFirst(roots),
    });
  }
  const loose: TreeNode[] = getChildren(selectedAgentId).filter((n) => !claimed.has(n.agentId));
  const looseIds = new Set(loose.map((n) => n.agentId));
  for (const spawn of spawns) {
    if (spawn.agentType === 'for_each') continue;
    if (IN_ACTIVITY_TYPES.has(spawn.agentType)) {
      const task = fromSpawn(spawn, selectedAgentId);
      if (!looseIds.has(task.agentId)) loose.push(task);
      continue;
    }
    for (const id of spawn.subAgentIds) {
      if (looseIds.has(id) || claimed.has(id)) continue;
      loose.push(withSpawnGoal(nodes.get(id), id, selectedAgentId, spawn.goal));
      looseIds.add(id);
    }
  }
  if (loose.length > 0) groups.push({ key: 'children', header: null, roots: runningFirst(loose) });
  groups.sort((a, b) => Number(b.roots.some(isRunningNode)) - Number(a.roots.some(isRunningNode)));
  return { groups, getChildren, counts: countAll(groups, getChildren) };
}
