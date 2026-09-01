/**
 * Slot hub fan-out trees into the live Agent CTE so existing prod FE breadcrumbs
 * work without a frontend deploy.
 *
 *   hub PUT run
 *     → archived Agent{id, parentAgentId, goal} (sentinel user, deletedAt set)
 *     → GET /agents/:id   misses live (deletedAt filter) → hub transcript
 *     → GET /ancestors    CTE walks parentAgentId (no deletedAt filter)
 *     → www.roselabs.ai SubAgentBreadcrumb renders parent > current
 *
 * Never overwrite deletedAt=null rows. Sentinel userId keeps skeletons out of
 * the sidebar/archive. O(tree) once per publish, not per request / 10k agents.
 */

import type { AgentStatus } from '@prisma/client';
import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('BenchmarkHubAncestors');

export const HUB_ANCESTOR_SKELETON_USER_ID = 'benchmark-hub-ancestors';
export const HUB_ANCESTOR_SKELETON_MODEL = 'benchmark-hub';

export interface HubAncestorNode {
  id: string;
  parentAgentId: string | null;
  busId: string;
  goal: string;
  status: string;
}

const AGENT_STATUSES = new Set<string>([
  'STARTING_UP',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
]);

export function toAgentStatus(raw: string): AgentStatus {
  const status = raw.trim().toUpperCase();
  if (status === 'PASSED' || status === 'PASS') return 'COMPLETED';
  if (AGENT_STATUSES.has(status)) return status as AgentStatus;
  return 'COMPLETED';
}

function nodeGoal(
  id: string,
  rootId: string,
  info: Record<string, unknown>,
  task: Record<string, unknown>,
  rootMessages: Array<Record<string, unknown>>
): string {
  if (typeof info.goal === 'string' && info.goal.length > 0) return info.goal;
  if (id !== rootId) return 'sub-agent';
  const userMessage = rootMessages.find(
    (message) => String(message.role ?? '').toUpperCase() === 'USER'
  );
  const fromUser = typeof userMessage?.message === 'string' ? userMessage.message : '';
  if (fromUser.length > 0) return fromUser;
  return typeof task.name === 'string' && task.name.length > 0 ? task.name : 'benchmark task';
}

function asAgentTree(raw: unknown): Record<string, Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    if (
      Array.isArray(node.messages) ||
      'parent_agent_id' in node ||
      typeof node.goal === 'string' ||
      typeof node.status === 'string'
    ) {
      out[key] = node;
    }
  }
  return out;
}

function taskAncestorNodes(task: Record<string, unknown>): HubAncestorNode[] {
  const rootId = typeof task.agent_id === 'string' ? task.agent_id.trim() : '';
  if (!rootId) return [];
  const logs = (task.logs ?? {}) as Record<string, unknown>;
  const tree = asAgentTree(logs.tree);
  const rootMessages = Array.isArray(logs.messages)
    ? (logs.messages as Array<Record<string, unknown>>)
    : [];
  const ids = new Set<string>([rootId, ...Object.keys(tree)]);
  return [...ids].map((id) => {
    const info = tree[id] ?? {};
    const parentRaw = info.parent_agent_id;
    const parentAgentId =
      id === rootId
        ? null
        : typeof parentRaw === 'string' && parentRaw.length > 0
          ? parentRaw
          : rootId;
    return {
      id,
      parentAgentId,
      busId: rootId,
      goal: nodeGoal(id, rootId, info, task, rootMessages),
      status: String(
        info.status ?? (id === rootId && task.passed === true ? 'COMPLETED' : 'COMPLETED')
      ),
    };
  });
}

/** Flatten every task's agent tree into CTE-shaped parent/child nodes. */
export function hubAncestorNodesFromBundle(bundle: Record<string, unknown>): HubAncestorNode[] {
  const tasks = Array.isArray(bundle.tasks) ? (bundle.tasks as Array<Record<string, unknown>>) : [];
  const byId = new Map<string, HubAncestorNode>();
  for (const task of tasks) {
    for (const node of taskAncestorNodes(task)) {
      byId.set(node.id, node);
    }
  }
  for (const node of [...byId.values()]) {
    if (node.parentAgentId && !byId.has(node.parentAgentId)) {
      byId.set(node.parentAgentId, {
        id: node.parentAgentId,
        parentAgentId: null,
        busId: node.busId,
        goal: 'parent',
        status: 'COMPLETED',
      });
    }
  }
  return [...byId.values()];
}

function visitTopo(
  id: string,
  byId: Map<string, HubAncestorNode>,
  seen: Set<string>,
  out: HubAncestorNode[]
) {
  if (seen.has(id)) return;
  seen.add(id);
  const node = byId.get(id);
  if (!node) return;
  if (node.parentAgentId) visitTopo(node.parentAgentId, byId, seen, out);
  out.push(node);
}

export function orderAncestorNodes(nodes: HubAncestorNode[]): HubAncestorNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered: HubAncestorNode[] = [];
  const seen = new Set<string>();
  for (const node of nodes) visitTopo(node.id, byId, seen, ordered);
  return ordered;
}

async function upsertSkeleton(node: HubAncestorNode, archivedAt: Date): Promise<boolean> {
  const existing = await prisma.agent.findUnique({
    where: { id: node.id },
    select: { deletedAt: true, userId: true, model: true },
  });
  if (existing?.deletedAt === null) return false;
  const ours =
    existing === null ||
    (existing.userId === HUB_ANCESTOR_SKELETON_USER_ID &&
      existing.model === HUB_ANCESTOR_SKELETON_MODEL);
  if (!ours) return false;
  const data = {
    userId: HUB_ANCESTOR_SKELETON_USER_ID,
    goal: node.goal,
    status: toAgentStatus(node.status),
    parentAgentId: node.parentAgentId,
    busId: node.busId,
    source: 'WEB' as const,
    model: HUB_ANCESTOR_SKELETON_MODEL,
    isBenchmark: true,
    deletedAt: existing?.deletedAt ?? archivedAt,
    writeLockEnabled: true,
  };
  if (existing === null) {
    await prisma.agent.create({ data: { id: node.id, ...data } });
  } else {
    await prisma.agent.update({ where: { id: node.id }, data });
  }
  return true;
}

/** Insert/update archived skeletons. Returns how many rows were written. */
export async function slotHubAncestorSkeletons(nodes: HubAncestorNode[]): Promise<number> {
  const archivedAt = new Date();
  let written = 0;
  for (const node of orderAncestorNodes(nodes)) {
    if (await upsertSkeleton(node, archivedAt)) written += 1;
  }
  if (written > 0) {
    log.info('Slotted hub ancestor skeletons', { written, nodes: nodes.length });
  }
  return written;
}

export async function slotHubAncestorSkeletonsFromBundle(
  bundle: Record<string, unknown>
): Promise<number> {
  return slotHubAncestorSkeletons(hubAncestorNodesFromBundle(bundle));
}

export async function deleteHubAncestorSkeletonsFromBundle(
  bundle: Record<string, unknown>
): Promise<number> {
  return deleteHubAncestorSkeletons(hubAncestorNodesFromBundle(bundle).map((node) => node.id));
}

export async function deleteHubAncestorSkeletons(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const children = await prisma.agent.deleteMany({
    where: {
      id: { in: ids },
      parentAgentId: { not: null },
      userId: HUB_ANCESTOR_SKELETON_USER_ID,
      model: HUB_ANCESTOR_SKELETON_MODEL,
      deletedAt: { not: null },
    },
  });
  const roots = await prisma.agent.deleteMany({
    where: {
      id: { in: ids },
      parentAgentId: null,
      userId: HUB_ANCESTOR_SKELETON_USER_ID,
      model: HUB_ANCESTOR_SKELETON_MODEL,
      deletedAt: { not: null },
    },
  });
  return children.count + roots.count;
}
