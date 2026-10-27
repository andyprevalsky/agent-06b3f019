/**
 * Background tasks (explore/browser/code activities) persisted on
 * Agent.backgroundTasks by the owner's tree-state PATCH: the running ones plus
 * the owner's newest finished ones (status completed/failed). The tree view
 * lists them as leaf nodes under their owner, addressed by their task path
 * (`<owner path>/<task_name>`, or `<owner id>/<task id>` for a path-less
 * owner); send_message_to_agent to that address lands in the owner's task
 * inbox (a finished task's owner wakes it for another run), and grep
 * trace_path resolves it to its owner.
 *
 * Bounded: they ride on rows the tree view already read (no extra query), at
 * most PER_OWNER_LIMIT per owner and TOTAL_LIMIT per response. An owner in a
 * terminal status lists only its finished tasks, so a crashed worker cannot
 * leave a stale "running" task.
 */

import { TERMINAL_STATUSES } from './statusBroadcastWorkflowId';
import { backgroundTaskEntrySchema, type BackgroundTaskEntry } from './types';

const PER_OWNER_LIMIT = 10;
const TOTAL_LIMIT = 100;

export interface BackgroundTaskOwner {
  id: string;
  depth: number;
  status: string;
  createdAt: Date;
  backgroundTasks: unknown;
}

export interface BackgroundTaskNode {
  /** The task's address: its path, or `<owner id>/<task id>` when the owner has no path. */
  agent_id: string;
  path: string | null;
  task_id: string;
  parent_agent_id: string;
  depth: number;
  goal: string;
  status: string;
  type: string;
  created_at: Date;
  child_count: number;
  active_child_count: number;
}

interface TaskOwner {
  status: string;
  backgroundTasks: unknown;
}

/** Running and finished tasks; malformed entries (and a terminal owner's "running" ones) are skipped. */
export function listedBackgroundTasks(owner: TaskOwner): BackgroundTaskEntry[] {
  if (!Array.isArray(owner.backgroundTasks)) return [];
  const ownerEnded = TERMINAL_STATUSES.has(owner.status);
  const entries: BackgroundTaskEntry[] = [];
  for (const raw of owner.backgroundTasks as unknown[]) {
    const parsed = backgroundTaskEntrySchema.safeParse(raw);
    if (parsed.success && !(ownerEnded && parsed.data.status === 'running')) {
      entries.push(parsed.data);
    }
  }
  return entries;
}

/** The owner's in-flight tasks. */
export function runningBackgroundTasks(owner: TaskOwner): BackgroundTaskEntry[] {
  return listedBackgroundTasks(owner).filter((entry) => entry.status === 'running');
}

function startedAt(entry: BackgroundTaskEntry, fallback: Date): Date {
  const date =
    entry.started_at !== undefined && entry.started_at !== null
      ? new Date(entry.started_at)
      : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/** The task's address: its path, or `<owner id>/<task id>` when the owner has no path. */
function taskAddress(owner: { id: string }, entry: BackgroundTaskEntry): string {
  return entry.path ?? `${owner.id}/${entry.address}`;
}

/**
 * Leaf nodes for the listed owners' tasks (running first, then finished), in owner order.
 * `keep` (search) filters each owner's tasks BEFORE the per-owner/response caps, so a
 * matching task is never dropped because unrelated tasks filled the cap.
 */
export function backgroundTaskNodes(
  owners: BackgroundTaskOwner[],
  keep: (address: string, entry: BackgroundTaskEntry) => boolean = () => true
): BackgroundTaskNode[] {
  const nodes: BackgroundTaskNode[] = [];
  for (const owner of owners) {
    const kept = listedBackgroundTasks(owner).filter((entry) =>
      keep(taskAddress(owner, entry), entry)
    );
    for (const entry of kept.slice(0, PER_OWNER_LIMIT)) {
      if (nodes.length >= TOTAL_LIMIT) return nodes;
      nodes.push({
        agent_id: taskAddress(owner, entry),
        path: entry.path ?? null,
        task_id: entry.address,
        parent_agent_id: owner.id,
        depth: owner.depth + 1,
        goal: entry.goal,
        status: entry.status,
        type: entry.type,
        created_at: startedAt(entry, owner.createdAt),
        child_count: 0,
        active_child_count: 0,
      });
    }
  }
  return nodes;
}
