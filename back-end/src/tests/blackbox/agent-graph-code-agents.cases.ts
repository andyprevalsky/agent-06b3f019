/**
 * Agent-graph cases for code-agent listings (UI contract):
 *   GET /api/agents/tree        → code_agents[].provider ('claude' | 'codex' | null)
 *   GET /api/agents/code-agents → batched by root ids, caller-scoped, max 50 roots
 *
 * Runs inside agent-graph.blackbox.ts against its seeded trees: userA owns
 * R (sessions S1 under C and S2 under R, both legacy rows without a provider);
 * userB owns R2 (S3).
 */
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';

export interface CodeAgentListContext {
  baseUrl: string;
  apiKey: string;
  userA: string;
  userB: string;
  ids: { R: string; C: string; R2: string; S1: string; S2: string; S3: string };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function get(ctx: CodeAgentListContext, path: string, userId: string) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    headers: { 'X-API-Key': ctx.apiKey, 'X-User-Id': userId },
  });
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

type CodeAgentItem = Record<string, unknown>;

export async function testCodeAgentRenamePersistsAndIsOwnerScoped(
  ctx: CodeAgentListContext
): Promise<void> {
  const taskId = randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId: ctx.ids.C,
      sandboxId: `sb-${taskId}`,
      goal: 'Original goal stays unchanged',
      taskName: 'original_task',
      codeProvider: 'codex',
      status: 'CLOSED',
    },
  });
  const patch = async (id: string, body: unknown, userId?: string, authenticated = true) => {
    const response = await fetch(`${ctx.baseUrl}/api/agents/code-agents/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { 'X-API-Key': ctx.apiKey } : {}),
        ...(userId === undefined ? {} : { 'X-User-Id': userId }),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text };
  };
  try {
    const renamed = await patch(taskId, { title: '  Parser repair — ready  ' }, ctx.userA);
    assert(renamed.status === 200, `rename: expected 200, got ${renamed.status} ${renamed.text}`);
    const result = JSON.parse(renamed.text) as Record<string, unknown>;
    assert(
      result.code_agent_id === taskId && result.title === 'Parser repair — ready',
      'rename response'
    );
    const listed = await get(ctx, `/api/agents/code-agents?root_ids=${ctx.ids.R}`, ctx.userA);
    const item = (listed.data.code_agents as CodeAgentItem[]).find(
      (row) => row.code_agent_id === taskId
    );
    assert(item?.title === 'Parser repair — ready', 'a fresh list reads the persisted title');
    assert(
      (await patch(taskId, { title: 'stolen' }, ctx.userB)).status === 404,
      'foreign task is hidden'
    );
    assert(
      (await patch(randomUUID(), { title: 'missing' }, ctx.userA)).status === 404,
      'missing task'
    );
    assert(
      (await patch(taskId, { title: 'unauthorized' }, ctx.userA, false)).status === 401,
      'authentication required'
    );
    assert((await patch(taskId, { title: 'unscoped' })).status === 401, 'user identity required');
    for (const body of [
      {},
      { title: null },
      { title: 12 },
      { title: '  ' },
      { title: 'x'.repeat(81) },
      { title: 'x'.repeat(161) },
    ]) {
      assert(
        (await patch(taskId, body, ctx.userA)).status === 400,
        `invalid title: ${JSON.stringify(body)}`
      );
    }
    const row = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: taskId } });
    assert(row.taskName === 'Parser repair — ready', 'denied and invalid writes preserve title');
    assert(
      row.goal === 'Original goal stays unchanged' &&
        row.status === 'CLOSED' &&
        row.codeProvider === 'codex',
      'rename preserves execution state'
    );
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: taskId } });
  }
}

export async function testCodeAgentProviderInTreeAndBatchedList(
  ctx: CodeAgentListContext
): Promise<void> {
  const withProvider = randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: withProvider,
      agentId: ctx.ids.R,
      sandboxId: `sb-${withProvider}`,
      goal: 'Fix the parser\nthen run the tests',
      status: 'ACTIVE',
      codeProvider: 'codex',
    },
  });
  // A spawn's task_name is the code agent's title (the sidebar row), never its goal.
  const named = randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: named,
      agentId: ctx.ids.R,
      sandboxId: `sb-${named}`,
      goal: 'You are working in the Rose UI sandbox.\nTask: remove the border',
      taskName: 'remove_rose_card_border',
      status: 'ACTIVE',
      codeProvider: 'claude',
    },
  });
  try {
    const tree = await get(ctx, `/api/agents/tree?busId=${ctx.ids.R}`, ctx.userA);
    assert(tree.status === 200, `tree: ${JSON.stringify(tree.data)}`);
    const treeAgents = new Map(
      (tree.data.code_agents as CodeAgentItem[]).map((item) => [item.code_agent_id, item])
    );
    assert(treeAgents.get(withProvider)?.provider === 'codex', 'tree reports the provider');
    assert(treeAgents.get(ctx.ids.S2)?.provider === null, 'legacy rows report provider null');

    const list = await get(
      ctx,
      `/api/agents/code-agents?root_ids=${ctx.ids.R},${ctx.ids.R2}`,
      ctx.userA
    );
    assert(list.status === 200, `list: ${JSON.stringify(list.data)}`);
    const items = list.data.code_agents as CodeAgentItem[];
    const byId = new Map(items.map((item) => [item.code_agent_id, item]));
    assert(byId.has(ctx.ids.S1) && byId.has(ctx.ids.S2), 'every code agent in the tree is listed');
    assert(!byId.has(ctx.ids.S3), "another user's root is never listed");
    const item = byId.get(withProvider);
    assert(item !== undefined, 'the provider row is listed');
    assert(item.provider === 'codex', 'list reports the provider');
    assert(item.owner_agent_id === ctx.ids.R && item.root_agent_id === ctx.ids.R, 'owner + root');
    assert(
      item.title === 'Fix the parser',
      `a legacy row without a task_name shows the goal's first line: ${String(item.title)}`
    );
    assert(item.status === 'ACTIVE' && typeof item.created_at === 'string', 'status + created_at');
    assert(
      byId.get(named)?.title === 'remove_rose_card_border',
      `title is the spawn's task_name: ${String(byId.get(named)?.title)}`
    );
    assert(byId.get(ctx.ids.S1)?.root_agent_id === ctx.ids.R, 'sub-agent sessions map to the root');
    assert(byId.get(ctx.ids.S1)?.owner_agent_id === ctx.ids.C, 'owned by the spawning sub-agent');

    const foreign = await get(ctx, `/api/agents/code-agents?root_ids=${ctx.ids.R}`, ctx.userB);
    assert(
      foreign.status === 200 && (foreign.data.code_agents as unknown[]).length === 0,
      'roots of other users list nothing'
    );
    const tooMany = Array.from({ length: 51 }, () => randomUUID()).join(',');
    const capped = await get(ctx, `/api/agents/code-agents?root_ids=${tooMany}`, ctx.userA);
    assert(capped.status === 400, `51 roots are rejected: ${capped.status}`);
    const fifty = Array.from({ length: 50 }, () => randomUUID()).join(',');
    assert(
      (await get(ctx, `/api/agents/code-agents?root_ids=${fifty}`, ctx.userA)).status === 200,
      '50 roots are accepted'
    );
    const missing = await get(ctx, '/api/agents/code-agents', ctx.userA);
    assert(missing.status === 400, 'root_ids is required');
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: { in: [withProvider, named] } } });
  }
}

/**
 * A busy tree never pushes its newest code agents (or another root's) off the
 * list: newest first, at most 50 per root. The list was oldest-first with one
 * 500-row cap across every requested root, so the newest sessions of a busy
 * page were the ones dropped.
 */
export async function testCodeAgentListIsNewestFirstPerRoot(
  ctx: CodeAgentListContext
): Promise<void> {
  const quiet = randomUUID();
  await prisma.agent.create({
    data: { id: quiet, userId: ctx.userA, busId: quiet, goal: 'quiet root', status: 'ACTIVE' },
  });
  const base = Date.now() - 24 * 60 * 60 * 1000;
  const busy = Array.from({ length: 55 }, (_, index) => ({
    id: randomUUID(),
    agentId: index % 2 === 0 ? ctx.ids.R : ctx.ids.C,
    sandboxId: `sb-busy-${index}`,
    goal: `busy ${index}`,
    status: 'CLOSED' as const,
    createdAt: new Date(base + (index + 10) * 60_000),
  }));
  const quietRows = [0, 1].map((index) => ({
    id: randomUUID(),
    agentId: quiet,
    sandboxId: `sb-quiet-${index}`,
    goal: `quiet ${index}`,
    status: 'CLOSED' as const,
    createdAt: new Date(base + index * 60_000),
  }));
  await prisma.claudeCodeSession.createMany({ data: [...busy, ...quietRows] });
  try {
    const list = await get(
      ctx,
      `/api/agents/code-agents?root_ids=${ctx.ids.R},${quiet}`,
      ctx.userA
    );
    assert(list.status === 200, `list: ${JSON.stringify(list.data)}`);
    const items = list.data.code_agents as CodeAgentItem[];
    const created = items.map((item) => Date.parse(String(item.created_at)));
    assert(
      created.every((value, index) => index === 0 || created[index - 1] >= value),
      'newest first'
    );
    const fromR = items.filter((item) => item.root_agent_id === ctx.ids.R);
    assert(fromR.length === 50, `at most 50 per root: ${fromR.length}`);
    const newest = await prisma.claudeCodeSession.findMany({
      where: { agentId: { in: [ctx.ids.R, ctx.ids.C] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { id: true },
    });
    assert(
      JSON.stringify(fromR.map((item) => item.code_agent_id)) ===
        JSON.stringify(newest.map((row) => row.id)),
      'the busy root keeps exactly its newest 50 code agents'
    );
    assert(
      !fromR.some((item) => item.code_agent_id === busy[0].id),
      'the oldest busy agent is the one left out'
    );
    const quietListed = items.filter((item) => item.root_agent_id === quiet);
    assert(quietListed.length === 2, "a busy root never crowds out another root's agents");
    const seeded = new Set([...busy, ...quietRows].map((row) => row.id));
    const seededItems = items.filter((item) => seeded.has(String(item.code_agent_id)));
    assert(
      seededItems.every(
        (item) =>
          item.awaiting_parent === null && item.code_session_id === null && item.status === 'CLOSED'
      ),
      `rows without a code session report no session, no question and stay CLOSED: ${JSON.stringify(seededItems[0])}`
    );
  } finally {
    await prisma.claudeCodeSession.deleteMany({
      where: { id: { in: [...busy, ...quietRows].map((row) => row.id) } },
    });
    await prisma.agent.deleteMany({ where: { id: quiet } });
  }
}
