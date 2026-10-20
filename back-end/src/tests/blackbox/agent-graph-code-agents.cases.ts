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
      `title is the goal's first line: ${String(item.title)}`
    );
    assert(item.status === 'ACTIVE' && typeof item.created_at === 'string', 'status + created_at');
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
    await prisma.claudeCodeSession.deleteMany({ where: { id: withProvider } });
  }
}
