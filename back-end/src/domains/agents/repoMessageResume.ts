/** Reads for a person's message that resumes a stopped agent (agentMessageResume.ts). */
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { applyResumeTotal } from '../../providers/resumeReportedSpend';

export async function findAgentStatus(agentId: string) {
  return prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
}

export async function findAgentForBrowserResume(agentId: string) {
  return prisma.agent.findFirst({
    // A deleted agent is never resumed (deletion only sets deletedAt).
    where: { id: agentId, deletedAt: null },
    select: {
      id: true,
      userId: true,
      model: true,
      status: true,
      temporalWorkflowId: true,
      backgroundTasks: true,
    },
  });
}

/** The first row of a browser task (its rows carry the task id and the spawn tool call). */
export async function findBrowserTaskFirstRow(agentId: string, browserTaskId: string) {
  return prisma.message.findFirst({
    where: {
      agentId,
      OR: [
        { metadata: { path: ['taskId'], equals: browserTaskId } },
        { metadata: { path: ['task_id'], equals: browserTaskId } },
      ],
    },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
}

export async function findBrowserSessionStatus(browserTaskId: string) {
  return prisma.browserSession.findUnique({
    where: { id: browserTaskId },
    select: { status: true },
  });
}

/** The browser task's last result row (its run's terminal text), for a fresh resume's context. */
export async function findLatestFinishedRow(agentId: string, toolCallId: string) {
  return prisma.message.findFirst({
    where: {
      agentId,
      AND: [
        { metadata: { path: ['toolCallId'], equals: toolCallId } },
        { metadata: { path: ['toolStatus'], equals: 'FINISHED' } },
      ],
    },
    orderBy: { timestamp: 'desc' },
    select: { text: true },
  });
}

/** A row that ended the browser task's resume after `since`: a failure or its run's task_complete. */
export async function findBrowserResumeEndSince(agentId: string, toolCallId: string, since: Date) {
  return prisma.message.findFirst({
    where: {
      agentId,
      timestamp: { gt: since },
      AND: [
        { metadata: { path: ['toolCallId'], equals: toolCallId } },
        {
          OR: [
            { metadata: { path: ['toolStatus'], equals: 'ERROR' } },
            { metadata: { path: ['action_type'], equals: 'task_complete' } },
          ],
        },
      ],
    },
    select: { id: true },
  });
}

/** The spawn arguments a background browser recorded on its started row (output schema, files). */
export async function findBackgroundSpawnArgs(agentId: string, toolCallId: string) {
  const row = await prisma.message.findFirst({
    where: {
      agentId,
      AND: [
        { metadata: { path: ['backgroundTaskId'], equals: toolCallId } },
        { metadata: { path: ['runInBackground'], equals: true } },
      ],
    },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
  const args = (row?.metadata as Record<string, unknown> | null)?.backgroundSpawnArgs;
  return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : null;
}

/** The owner's file pointers by original filename (the spawn named them). */
export async function findOwnerFilePointers(agentId: string, names: string[]) {
  if (names.length === 0) return [];
  const rows = await prisma.message.findMany({
    where: { agentId, filePointer: { path: ['original_filename'], string_contains: '' } },
    select: { filePointer: true },
    orderBy: { timestamp: 'desc' },
    take: 200,
  });
  const byName = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const pointer = row.filePointer as Record<string, unknown> | null;
    const name = pointer?.original_filename;
    if (typeof name === 'string' && !byName.has(name))
      byName.set(name, pointer as Record<string, unknown>);
  }
  return names.flatMap((name) =>
    byName.has(name) ? [byName.get(name) as Record<string, unknown>] : []
  );
}

/** Most agents of one tree read to find a paused agent's subtree (bounded). */
const TREE_SCAN_LIMIT = 1000;

/** The paused agent and every agent below it in its tree (one indexed read by busId). */
export async function findSubtreeAgentIds(agentId: string): Promise<string[]> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { busId: true } });
  if (agent === null) return [agentId];
  const tree = await prisma.agent.findMany({
    where: { busId: agent.busId ?? agentId },
    select: { id: true, parentAgentId: true },
    take: TREE_SCAN_LIMIT,
  });
  const children = new Map<string, string[]>();
  for (const node of tree) {
    if (node.parentAgentId === null) continue;
    children.set(node.parentAgentId, [...(children.get(node.parentAgentId) ?? []), node.id]);
  }
  const subtree = [agentId];
  for (let index = 0; index < subtree.length; index += 1) {
    subtree.push(...(children.get(subtree[index]) ?? []));
  }
  return subtree;
}

/** Most ancestors walked from an owner to its root (a deeper tree is a bug elsewhere). */
const MAX_ANCESTOR_HOPS = 16;

/** The owner and its ancestors up to the root, owner first (indexed reads by id). */
async function ownerChain(agentId: string) {
  type ChainAgent = {
    id: string;
    parentAgentId: string | null;
    status: string;
    treeCostCents: number;
    priceLimitCents: number;
  };
  const chain: ChainAgent[] = [];
  let next: string | null = agentId;
  for (let hop = 0; next !== null && hop <= MAX_ANCESTOR_HOPS; hop += 1) {
    const agent: ChainAgent | null = await prisma.agent.findUnique({
      where: { id: next },
      select: {
        id: true,
        parentAgentId: true,
        status: true,
        treeCostCents: true,
        priceLimitCents: true,
      },
    });
    if (agent === null) break;
    chain.push(agent);
    next = agent.parentAgentId;
  }
  return chain;
}

/** Raise a resume run's ledger total in one transaction with the chain's tree increments. */
export async function raiseResumeTotal(chain: string[], key: string, total: number) {
  return runTransactionWithRetry((tx) => applyResumeTotal(tx, chain, key, total));
}

/** The owner and its ancestors up to the root, owner first (ids). */
export async function ownerChainIds(agentId: string): Promise<string[]> {
  return (await ownerChain(agentId)).map((agent) => agent.id);
}

/** Whether the owner's root reached its cost limit (its status, or its tree cost at the limit). */
export async function rootCostLimitReached(agentId: string): Promise<boolean> {
  const chain = await ownerChain(agentId);
  const root = chain.at(-1);
  if (root === undefined) return false;
  return root.status === 'COST_LIMIT_REACHED' || root.treeCostCents >= root.priceLimitCents;
}
