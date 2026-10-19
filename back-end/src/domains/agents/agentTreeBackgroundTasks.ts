/**
 * In-flight background tasks (explore/browser/code activities) persisted on
 * Agent.backgroundTasks by the owner's tree-state PATCH. The tree view lists
 * them as leaf nodes under their owner, addressed by their task path
 * (`<owner path>/<task_name>`, or `<owner id>/<task id>` for a path-less
 * owner); send_message_to_agent to that address lands in the owner's task inbox.
 *
 * Bounded: they ride on rows the tree view already read (no extra query), at
 * most PER_OWNER_LIMIT per owner and TOTAL_LIMIT per response. Owners in a
 * terminal status list none, so a crashed worker cannot leave stale tasks.
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

/** The owner's in-flight tasks; malformed entries are skipped. */
export function runningBackgroundTasks(owner: {
  status: string;
  backgroundTasks: unknown;
}): BackgroundTaskEntry[] {
  if (TERMINAL_STATUSES.has(owner.status) || !Array.isArray(owner.backgroundTasks)) return [];
  const entries: BackgroundTaskEntry[] = [];
  for (const raw of owner.backgroundTasks as unknown[]) {
    const parsed = backgroundTaskEntrySchema.safeParse(raw);
    if (parsed.success && parsed.data.status === 'running') entries.push(parsed.data);
  }
  return entries;
}

function startedAt(entry: BackgroundTaskEntry, fallback: Date): Date {
  const date =
    entry.started_at !== undefined && entry.started_at !== null
      ? new Date(entry.started_at)
      : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/** Leaf nodes for the listed owners' running tasks, in owner order. */
export function backgroundTaskNodes(owners: BackgroundTaskOwner[]): BackgroundTaskNode[] {
  const nodes: BackgroundTaskNode[] = [];
  for (const owner of owners) {
    for (const entry of runningBackgroundTasks(owner).slice(0, PER_OWNER_LIMIT)) {
      if (nodes.length >= TOTAL_LIMIT) return nodes;
      nodes.push({
        agent_id: entry.path ?? `${owner.id}/${entry.address}`,
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
