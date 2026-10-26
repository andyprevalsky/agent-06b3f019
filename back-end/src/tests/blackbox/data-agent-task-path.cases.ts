/**
 * grep `trace_path` as an agent task path (/root/..., as list_agents prints it):
 *
 *   agent_network      /root/outreach → that agent + its subtree, never a sibling branch
 *   agent_trajectories /root/outreach → same scope inside the caller's own (live) tree,
 *                      which unscoped trajectory search excludes
 *   results carry the agent's task path (location.agent_path; `agent_path:` in content)
 *   a background-task path narrows to its owner; an unknown path → 404 AGENT_PATH_NOT_FOUND
 *   a path is resolved only inside the caller's tree; a missing agent_id → 400
 *   agent_network rows are stored messages, so record_kind message/all reads them;
 *   order is accepted and ignored on a sole agent_network search (newest first);
 *   a model-record kind, surface, until, page_after or non-task trace_path → 400
 *   naming that parameter; order with another source → 400 order/page_after
 *
 * Registered by data.blackbox.ts.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

interface GrepBody {
  matches: Array<{ content: string; location: { agent_id?: string; agent_path?: string } }>;
  total_matches: number;
  error?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function grep(headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as GrepBody };
}

interface Tree {
  rootId: string;
  childId: string;
  grandchildId: string;
  siblingId: string;
  otherRootId: string;
  marker: string;
}

/** /root → /root/outreach → /root/outreach/napa, /root/billing; plus an unrelated tree. */
async function createTree(userId: string): Promise<Tree> {
  const marker = `taskpath-${randomUUID().slice(0, 8)}`;
  const root = await prisma.agent.create({
    data: { userId, goal: `Plan offsite ${marker}`, taskPath: '/root', status: 'ACTIVE' },
  });
  const child = await prisma.agent.create({
    data: {
      userId,
      goal: 'Venue outreach',
      parentAgentId: root.id,
      busId: root.id,
      depth: 1,
      taskPath: '/root/outreach',
      status: 'ACTIVE',
      backgroundTasks: [
        {
          address: 'toolu_explore_1',
          type: 'explore',
          goal: 'Find venues',
          status: 'running',
          task_name: 'venues',
          path: '/root/outreach/venues',
        },
        {
          address: 'toolu_explore_0',
          type: 'explore',
          goal: 'Find caterers',
          status: 'completed',
          task_name: 'caterers',
          path: '/root/outreach/caterers',
        },
      ],
    },
  });
  const grandchild = await prisma.agent.create({
    data: {
      userId,
      goal: 'Email Napa',
      parentAgentId: child.id,
      busId: root.id,
      depth: 2,
      taskPath: '/root/outreach/napa',
      status: 'ACTIVE',
    },
  });
  const sibling = await prisma.agent.create({
    data: {
      userId,
      goal: 'Billing',
      parentAgentId: root.id,
      busId: root.id,
      depth: 1,
      taskPath: '/root/billing',
      status: 'ACTIVE',
    },
  });
  // A second tree with the same paths must never be reachable from the first.
  const otherRoot = await prisma.agent.create({
    data: { userId, goal: 'Other tree', taskPath: '/root', status: 'COMPLETED' },
  });
  const otherChild = await prisma.agent.create({
    data: {
      userId,
      goal: 'Other outreach',
      parentAgentId: otherRoot.id,
      busId: otherRoot.id,
      depth: 1,
      taskPath: '/root/outreach',
      status: 'COMPLETED',
    },
  });
  // One second apart, in creation order, so read order is deterministic.
  const start = Date.now() - 60_000;
  await prisma.message.createMany({
    data: [root, child, grandchild, sibling, otherChild].map((agent, index) => ({
      agentId: agent.id,
      role: 'ASSISTANT' as const,
      text: `${marker} evidence from ${agent.taskPath}`,
      createdAt: new Date(start + index * 1000),
    })),
  });
  return {
    rootId: root.id,
    childId: child.id,
    grandchildId: grandchild.id,
    siblingId: sibling.id,
    otherRootId: otherRoot.id,
    marker,
  };
}

async function deleteTree(tree: Tree): Promise<void> {
  const ids = await prisma.agent.findMany({
    where: { OR: [{ busId: { in: [tree.rootId, tree.otherRootId] } }] },
    select: { id: true },
  });
  const all = [...ids.map((row) => row.id), tree.rootId, tree.otherRootId];
  await prisma.message.deleteMany({ where: { agentId: { in: all } } });
  await prisma.$executeRaw`DELETE FROM "AgentTrajectorySearch" WHERE "agentId" = ANY(${all})`;
  await prisma.agent.deleteMany({ where: { busId: { in: [tree.rootId, tree.otherRootId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [tree.rootId, tree.otherRootId] } } });
}

function agentIds(body: GrepBody): string[] {
  return [...new Set(body.matches.map((m) => m.location.agent_id ?? ''))].sort();
}

async function proveAgentNetworkScope(headers: Record<string, string>, tree: Tree): Promise<void> {
  const base = { pattern: tree.marker, sources: ['agent_network'], agent_id: tree.grandchildId };
  const scoped = await grep(headers, { ...base, trace_path: '/root/outreach' });
  assert(scoped.status === 200, `agent_network /root path: ${JSON.stringify(scoped.data)}`);
  assert(
    JSON.stringify(agentIds(scoped.data)) ===
      JSON.stringify([tree.childId, tree.grandchildId].sort()),
    `/root/outreach covers the agent and its subtree only, got ${JSON.stringify(scoped.data)}`
  );
  const napa = scoped.data.matches.find((m) => m.location.agent_id === tree.grandchildId);
  assert(
    napa?.location.agent_path === '/root/outreach/napa',
    `results show the agent's task path, got ${JSON.stringify(napa)}`
  );
  const listed = await grep(headers, {
    sources: ['agent_network'],
    agent_id: tree.grandchildId,
    trace_path: '/root/outreach/napa',
  });
  assert(
    listed.data.matches.some((m) => m.content.includes('agent_path: /root/outreach/napa')),
    `a pattern-less listing prints agent_path, got ${JSON.stringify(listed.data)}`
  );
  const leaf = await grep(headers, { ...base, trace_path: '/root/outreach/napa/' });
  assert(
    JSON.stringify(agentIds(leaf.data)) === JSON.stringify([tree.grandchildId]),
    `a leaf path narrows to one agent, got ${JSON.stringify(leaf.data)}`
  );
  const whole = await grep(headers, { ...base, trace_path: '/root' });
  assert(
    agentIds(whole.data).length === 4 &&
      whole.data.matches.some((m) => m.location.agent_path === '/root'),
    `/root covers this whole tree only, got ${JSON.stringify(whole.data)}`
  );
  const task = await grep(headers, { ...base, trace_path: '/root/outreach/venues' });
  assert(
    JSON.stringify(agentIds(task.data)) === JSON.stringify([tree.childId]),
    `a background task path narrows to its owner, got ${JSON.stringify(task.data)}`
  );
  const finished = await grep(headers, { ...base, trace_path: '/root/outreach/caterers' });
  assert(
    JSON.stringify(agentIds(finished.data)) === JSON.stringify([tree.childId]),
    `a finished background task path still narrows to its owner, got ${JSON.stringify(finished.data)}`
  );
  const missing = await grep(headers, { ...base, trace_path: '/root/nobody' });
  assert(
    missing.status === 404 && missing.data.error === 'AGENT_PATH_NOT_FOUND',
    `unknown path → 404, got ${missing.status} ${JSON.stringify(missing.data)}`
  );
  const noCaller = await grep(headers, {
    pattern: tree.marker,
    sources: ['agent_network'],
    trace_path: '/root/outreach',
  });
  assert(noCaller.status === 400, `a task path needs agent_id, got ${noCaller.status}`);
}

async function proveTrajectoryScope(headers: Record<string, string>, tree: Tree): Promise<void> {
  const res = await grep(headers, {
    pattern: tree.marker,
    sources: ['agent_trajectories'],
    agent_id: tree.siblingId,
    trace_path: '/root/outreach',
  });
  assert(res.status === 200, `agent_trajectories /root path: ${JSON.stringify(res.data)}`);
  assert(
    JSON.stringify(agentIds(res.data)) === JSON.stringify([tree.childId, tree.grandchildId].sort()),
    `own live tree, subtree only (not the other tree's /root/outreach), got ${JSON.stringify(res.data)}`
  );
  assert(
    res.data.matches.every((m) => m.content.includes('agent_path: /root/outreach')),
    `trajectory headings carry agent_path, got ${JSON.stringify(res.data)}`
  );
  const unscoped = await grep(headers, {
    pattern: tree.marker,
    sources: ['agent_trajectories'],
    agent_id: tree.siblingId,
  });
  assert(
    !agentIds(unscoped.data).some((id) => [tree.childId, tree.grandchildId].includes(id)),
    `unscoped trajectory search still excludes the caller's tree, got ${JSON.stringify(unscoped.data)}`
  );
}

/**
 * Reading a sibling's trajectory the way list_agents advertises it, with the
 * schema's record_kind selector. agent_network holds only stored messages, so
 * message and all select every row; model-record kinds live only in
 * agent_trajectories and are rejected by name.
 */
async function proveAgentNetworkRecordKind(
  headers: Record<string, string>,
  tree: Tree
): Promise<void> {
  for (const recordKind of ['all', 'message']) {
    const res = await grep(headers, {
      source: 'agent_network',
      record_kind: recordKind,
      trace_path: '/root/outreach/napa',
      agent_id: tree.siblingId,
    });
    assert(
      res.status === 200,
      `agent_network record_kind=${recordKind} reads the stored messages, got ${res.status} ${JSON.stringify(res.data)}`
    );
    assert(
      JSON.stringify(agentIds(res.data)) === JSON.stringify([tree.grandchildId]) &&
        res.data.matches.some((m) => m.content.includes(tree.marker)),
      `agent_network record_kind=${recordKind} keeps the trace_path scope, got ${JSON.stringify(res.data)}`
    );
  }
  for (const order of ['oldest_first', 'newest_first']) {
    const res = await grep(headers, {
      pattern: tree.marker,
      sources: ['agent_network'],
      order,
      trace_path: '/root',
      agent_id: tree.siblingId,
    });
    assert(
      res.status === 200 &&
        res.data.matches[0]?.location.agent_id === tree.siblingId &&
        (res.data as unknown as { display_order?: string }).display_order === 'newest_first',
      `agent_network ignores order=${order} and reads newest first, got ${res.status} ${JSON.stringify(res.data)}`
    );
  }
  for (const [key, value] of [
    ['record_kind', 'llm_output'],
    ['surface', 'WEB'],
    ['until', '2026-10-25T00:00:00Z'],
    [
      'page_after',
      `agent_trajectories/${tree.rootId}/depth-0/${tree.rootId}/ASSISTANT/${tree.rootId}`,
    ],
    ['trace_path', `agent_trajectories/${tree.rootId}`],
  ] as const) {
    const res = await grep(headers, {
      sources: ['agent_network'],
      trace_path: '/root/outreach/napa',
      agent_id: tree.siblingId,
      [key]: value,
    });
    assert(
      res.status === 400 && JSON.stringify(res.data).includes(`'${key}'`),
      `agent_network rejects ${key}=${value} by name, got ${res.status} ${JSON.stringify(res.data)}`
    );
  }
  const mixed = await grep(headers, {
    pattern: tree.marker,
    sources: ['agent_network', 'messages'],
    order: 'oldest_first',
    agent_id: tree.siblingId,
  });
  assert(
    mixed.status === 400 && JSON.stringify(mixed.data).includes("'order/page_after'"),
    `order with another source is rejected, got ${mixed.status} ${JSON.stringify(mixed.data)}`
  );
}

/**
 * Task paths are unique only among live agents, so an archived agent can share
 * /root/outreach with the live one. A path scope must resolve to live agents.
 */
async function proveArchivedPathHolderExcluded(
  userId: string,
  headers: Record<string, string>,
  tree: Tree
): Promise<void> {
  const archived = await prisma.agent.create({
    data: {
      userId,
      goal: 'Earlier venue outreach (archived)',
      parentAgentId: tree.rootId,
      busId: tree.rootId,
      depth: 1,
      taskPath: '/root/outreach',
      status: 'COMPLETED',
      deletedAt: new Date(),
    },
  });
  await prisma.message.create({
    data: {
      agentId: archived.id,
      role: 'ASSISTANT',
      text: `${tree.marker} evidence from the archived /root/outreach`,
    },
  });
  const expected = JSON.stringify([tree.childId, tree.grandchildId].sort());
  for (const [source, callerId] of [
    ['agent_network', tree.grandchildId],
    ['agent_trajectories', tree.siblingId],
  ] as const) {
    const res = await grep(headers, {
      pattern: tree.marker,
      sources: [source],
      agent_id: callerId,
      trace_path: '/root/outreach',
    });
    assert(
      res.status === 200,
      `${source} with an archived path holder: ${JSON.stringify(res.data)}`
    );
    assert(
      JSON.stringify(agentIds(res.data)) === expected,
      `${source} /root/outreach excludes the archived agent at that path, got ${JSON.stringify(res.data)}`
    );
  }
}

export async function testGrepAgentTaskPaths(
  userId: string,
  headers: Record<string, string>
): Promise<void> {
  const tree = await createTree(userId);
  try {
    await proveAgentNetworkScope(headers, tree);
    await proveTrajectoryScope(headers, tree);
    await proveAgentNetworkRecordKind(headers, tree);
    await proveArchivedPathHolderExcluded(userId, headers, tree);
  } finally {
    await deleteTree(tree);
  }
}
