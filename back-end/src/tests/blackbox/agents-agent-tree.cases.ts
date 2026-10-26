/**
 * GET /:id/tree navigable view: caller path, siblings, children, node
 * expansion, keyset pagination, goal search with breadcrumbs, same-tree auth
 * and clamped limits.
 *
 * Fixture (rows inserted directly; createdAt strictly increasing):
 *
 *   root ─┬─ research ── rKid            "Price check Napa venue" (COMPLETED)
 *         ├─ outreach ─┬─ draftA ── aKid "Look up Napa venue contact"
 *         │            └─ draftB         (COMPLETED)
 *         ├─ budget                      (FAILED)
 *         └─ fanout ── 25 children
 */
import {
  BASE_URL,
  apiKeyHeaders,
  assert,
  assertStatus,
  createAnonymousSession,
  prisma,
  randomUUID,
  request,
  test,
} from './agents-blackbox-harness';

type Status = 'ACTIVE' | 'COMPLETED' | 'FAILED';

export interface Fixture {
  userId: string;
  ids: Record<string, string>;
  fanoutKids: string[];
  paths: Record<string, string>;
}

const TASK_NAMES: Record<string, string> = {
  rKid: 'price_check',
  draftA: 'draft_a',
  draftB: 'draft_b',
  aKid: 'lookup',
};
for (let i = 0; i < 25; i += 1) TASK_NAMES[`fan${i}`] = `invite_${i}`;

interface PathEntry {
  agent_id: string;
  path: string | null;
  goal: string;
  status: string;
  depth: number;
}

interface TreeNode extends PathEntry {
  parent_agent_id: string | null;
  child_count: number;
  active_child_count: number;
  tools_in_use?: string[];
}

export interface TreeView {
  root_agent_id: string;
  caller_path: PathEntry[];
  node_path: PathEntry[];
  nodes: TreeNode[];
  next_cursor: string | null;
  sibling_next_cursor: string | null;
  matches?: Array<PathEntry & { ancestor_ids: string[]; type?: string }>;
}

const LONG_GOAL = `Coordinate venue outreach ${'and follow-ups '.repeat(25)}`;

export async function createFixture(label: string): Promise<Fixture> {
  const session = await createAnonymousSession(label);
  const userId = session.user.id;
  const ids: Record<string, string> = {};
  const rows: Array<{
    key: string;
    parent: string | null;
    depth: number;
    goal: string;
    status: Status;
  }> = [
    {
      key: 'root',
      parent: null,
      depth: 0,
      goal: `Plan a team offsite (${label})`,
      status: 'ACTIVE',
    },
    { key: 'research', parent: 'root', depth: 1, goal: 'Research venues', status: 'ACTIVE' },
    { key: 'outreach', parent: 'root', depth: 1, goal: LONG_GOAL, status: 'ACTIVE' },
    { key: 'budget', parent: 'root', depth: 1, goal: 'Build the budget', status: 'FAILED' },
    { key: 'fanout', parent: 'root', depth: 1, goal: 'Invite every attendee', status: 'ACTIVE' },
    {
      key: 'rKid',
      parent: 'research',
      depth: 2,
      goal: 'Price check Napa venue',
      status: 'COMPLETED',
    },
    { key: 'draftA', parent: 'outreach', depth: 2, goal: 'Email Napa venue', status: 'ACTIVE' },
    {
      key: 'draftB',
      parent: 'outreach',
      depth: 2,
      goal: 'Email Sonoma venue',
      status: 'COMPLETED',
    },
    {
      key: 'aKid',
      parent: 'draftA',
      depth: 3,
      goal: 'Look up Napa venue contact',
      status: 'ACTIVE',
    },
  ];
  for (let i = 0; i < 25; i += 1) {
    rows.push({
      key: `fan${i}`,
      parent: 'fanout',
      depth: 2,
      goal: `Invite attendee ${i}`,
      status: 'ACTIVE',
    });
  }
  for (const row of rows) ids[row.key] = randomUUID();
  const paths: Record<string, string> = {};
  for (const row of rows) {
    paths[row.key] =
      row.parent === null ? '/root' : `${paths[row.parent]}/${TASK_NAMES[row.key] ?? row.key}`;
  }
  const start = Date.now() - 60_000;
  await prisma.agent.createMany({
    data: rows.map((row, index) => ({
      id: ids[row.key],
      userId,
      goal: row.goal,
      status: row.status,
      model: 'rose-labs/rose-1-ultra',
      parentAgentId: row.parent === null ? null : ids[row.parent],
      busId: ids.root,
      depth: row.depth,
      taskPath: paths[row.key],
      createdAt: new Date(start + index * 1000),
    })),
  });
  const fanoutKids = rows.filter((row) => /^fan\d+$/.test(row.key)).map((row) => ids[row.key]);
  return { userId, ids, fanoutKids, paths };
}

export async function deleteFixture(fixture: Fixture): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId: fixture.userId } });
}

export async function getTree(
  userId: string,
  agentId: string,
  params: Record<string, string> = {}
) {
  const qs = new URLSearchParams(params).toString();
  return request(`${BASE_URL}/api/agents/${agentId}/tree${qs === '' ? '' : `?${qs}`}`, {
    headers: apiKeyHeaders(userId),
  });
}

export async function getView(
  userId: string,
  agentId: string,
  params: Record<string, string> = {}
) {
  const res = await getTree(userId, agentId, params);
  assertStatus(res.status, 200, res.data);
  return res.data as TreeView;
}

export const idsOf = (entries: Array<{ agent_id: string }>) =>
  entries.map((entry) => entry.agent_id);
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

test('GET /:id/tree — default caller view: path, siblings, children, direct-child counts', async () => {
  const fx = await createFixture('tree-default');
  const { ids } = fx;
  try {
    await prisma.agent.update({ where: { id: ids.draftA }, data: { toolsInUse: ['web_search'] } });
    const view = await getView(fx.userId, ids.outreach);
    assert(view.root_agent_id === ids.root, 'root id');
    assert(same(idsOf(view.caller_path), [ids.root, ids.outreach]), 'caller_path root→caller');
    assert(same(idsOf(view.node_path), [ids.root, ids.outreach]), 'node defaults to the caller');
    const expected = [
      ids.root,
      ids.research,
      ids.outreach,
      ids.budget,
      ids.fanout,
      ids.draftA,
      ids.draftB,
    ];
    assert(
      same(idsOf(view.nodes), expected),
      `ancestors + siblings + children, got ${JSON.stringify(idsOf(view.nodes))}`
    );
    const byId = new Map(view.nodes.map((node) => [node.agent_id, node]));
    const counts = (id: string) => [byId.get(id)?.child_count, byId.get(id)?.active_child_count];
    assert(same(counts(ids.root), [4, 3]), `root counts ${JSON.stringify(counts(ids.root))}`);
    assert(same(counts(ids.outreach), [2, 1]), 'caller counts');
    assert(same(counts(ids.fanout), [25, 25]), 'fanout counts');
    assert(same(counts(ids.draftA), [1, 1]), 'collapsed grandchild still reports its children');
    assert(byId.get(ids.draftA)?.parent_agent_id === ids.outreach, 'parent ids');
    assert(
      same(byId.get(ids.draftA)?.tools_in_use, ['web_search']),
      'nodes carry toolsInUse (environment status tail)'
    );
    assert(byId.get(ids.outreach)?.goal.length === 200, 'goal capped at 200 chars');
    assert(view.caller_path[1].goal.length === 200, 'path goal capped at 200 chars');
    assert(view.next_cursor === null, 'caller children fit one page');
    assert(view.sibling_next_cursor === null, 'siblings fit one page');
    assert(view.matches === undefined, 'no matches without q');
  } finally {
    await deleteFixture(fx);
  }
});

test('GET /:id/tree — node expansion with depth=2 stays bounded by limit', async () => {
  const fx = await createFixture('tree-expand');
  const { ids } = fx;
  try {
    await prisma.agent.update({ where: { id: ids.rKid }, data: { toolsInUse: ['web_fetch'] } });
    const view = await getView(fx.userId, ids.aKid, { node: ids.root, depth: '2', limit: '5' });
    assert(
      same(idsOf(view.caller_path), [ids.root, ids.outreach, ids.draftA, ids.aKid]),
      'caller path'
    );
    assert(same(idsOf(view.node_path), [ids.root]), 'node path');
    const nodeIds = idsOf(view.nodes);
    const expected = [
      ids.root,
      ids.research,
      ids.outreach,
      ids.budget,
      ids.fanout,
      ids.rKid,
      ids.draftA,
      ids.draftB,
      ...fx.fanoutKids.slice(0, 5),
    ];
    assert(same(nodeIds, expected), `depth-2 expansion, got ${JSON.stringify(nodeIds)}`);
    assert(!nodeIds.includes(ids.aKid), 'level 3 is not expanded at depth=2');
    const missingTools = view.nodes.filter((node) => !Array.isArray(node.tools_in_use));
    assert(
      missingTools.length === 0,
      `every expanded node carries tools_in_use, missing on ${JSON.stringify(idsOf(missingTools))}`
    );
    const rKid = view.nodes.find((node) => node.agent_id === ids.rKid);
    assert(
      same(rKid?.tools_in_use, ['web_fetch']),
      `a depth-2 node keeps its toolsInUse, got ${JSON.stringify(rKid?.tools_in_use)}`
    );
    assert(view.next_cursor === null, 'root has fewer direct children than limit');
  } finally {
    await deleteFixture(fx);
  }
});

test('GET /:id/tree — cursor pages through more than limit direct children', async () => {
  const fx = await createFixture('tree-page');
  const { ids } = fx;
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    const pageSizes: number[] = [];
    for (let page = 0; page < 5; page += 1) {
      const params: Record<string, string> = { node: ids.fanout, limit: '10' };
      if (cursor !== null) params.cursor = cursor;
      const view = await getView(fx.userId, ids.root, params);
      const kids = view.nodes.filter((node) => node.parent_agent_id === ids.fanout);
      assert(view.nodes[0].agent_id === ids.fanout, 'expanded node is listed first');
      assert(
        view.nodes.length === kids.length + 1,
        'a non-caller node view lists only node + page'
      );
      pageSizes.push(kids.length);
      seen.push(...idsOf(kids));
      cursor = view.next_cursor;
      if (cursor === null) break;
    }
    assert(same(pageSizes, [10, 10, 5]), `page sizes ${JSON.stringify(pageSizes)}`);
    assert(same(seen, fx.fanoutKids), 'pages are disjoint and ordered by creation');

    const caller = await getView(fx.userId, fx.fanoutKids[0], { limit: '3' });
    const shownSiblings = caller.nodes.filter((node) => node.parent_agent_id === ids.fanout);
    assert(
      same(idsOf(shownSiblings), fx.fanoutKids.slice(0, 3)),
      'caller sees its first sibling page'
    );
    assert(caller.sibling_next_cursor !== null, 'caller view exposes the sibling page cursor');
    const nextSiblings = await getView(fx.userId, fx.fanoutKids[0], {
      node: ids.fanout,
      limit: '3',
      cursor: caller.sibling_next_cursor ?? '',
    });
    assert(
      same(idsOf(nextSiblings.nodes.slice(1)), fx.fanoutKids.slice(3, 6)),
      'sibling cursor continues on the parent node'
    );

    const bad = await getTree(fx.userId, ids.root, { node: ids.fanout, cursor: 'not-a-cursor' });
    assertStatus(bad.status, 400, bad.data);
  } finally {
    await deleteFixture(fx);
  }
});

test('GET /:id/tree — q searches goals in the tree and returns breadcrumb paths', async () => {
  const fx = await createFixture('tree-search');
  const other = await createFixture('tree-search-other');
  const { ids } = fx;
  try {
    const view = await getView(fx.userId, ids.draftB, { q: 'NAPA venue' });
    const matches = view.matches ?? [];
    assert(
      same(idsOf(matches), [ids.rKid, ids.draftA, ids.aKid]),
      `matches ${JSON.stringify(idsOf(matches))}`
    );
    assert(same(matches[0].ancestor_ids, [ids.root, ids.research]), 'rKid breadcrumb');
    assert(same(matches[2].ancestor_ids, [ids.root, ids.outreach, ids.draftA]), 'aKid breadcrumb');
    assert(matches[2].path === '/root/outreach/draft_a/lookup', 'match carries its task path');
    assert(matches[2].depth === 3 && matches[2].status === 'ACTIVE', 'match fields');
    assert(view.nodes.length === 0 && view.next_cursor === null, 'search mode lists matches only');
    assert(
      same(idsOf(view.caller_path), [ids.root, ids.outreach, ids.draftB]),
      'caller path in search'
    );
    const limited = await getView(fx.userId, ids.draftB, { q: 'venue', limit: '2' });
    assert((limited.matches ?? []).length === 2, 'search honours limit');
  } finally {
    await deleteFixture(other);
    await deleteFixture(fx);
  }
});

test('GET /:id/tree — node outside the caller tree is 403/404', async () => {
  const fx = await createFixture('tree-auth');
  const sameUserOther = randomUUID();
  const stranger = await createFixture('tree-auth-stranger');
  try {
    await prisma.agent.create({
      data: {
        id: sameUserOther,
        userId: fx.userId,
        goal: 'Unrelated tree root',
        status: 'ACTIVE',
        model: 'rose-labs/rose-1-ultra',
        busId: sameUserOther,
      },
    });
    const crossTree = await getTree(fx.userId, fx.ids.outreach, { node: sameUserOther });
    assertStatus(crossTree.status, 403, crossTree.data);
    const crossUser = await getTree(fx.userId, fx.ids.outreach, { node: stranger.ids.root });
    assertStatus(crossUser.status, 404, crossUser.data);
    const missing = await getTree(fx.userId, fx.ids.outreach, { node: randomUUID() });
    assertStatus(missing.status, 404, missing.data);
    const strangerCaller = await getTree(stranger.userId, fx.ids.outreach);
    assertStatus(strangerCaller.status, 404, strangerCaller.data);
    const notUuid = await getTree(fx.userId, fx.ids.outreach, { node: 'Not An Address' });
    assertStatus(notUuid.status, 400, notUuid.data);
    await prisma.agent.update({ where: { id: fx.ids.budget }, data: { deletedAt: new Date() } });
    const deleted = await getTree(fx.userId, fx.ids.outreach, { node: fx.ids.budget });
    assertStatus(deleted.status, 404, deleted.data);
    const view = await getView(fx.userId, fx.ids.outreach);
    assert(!idsOf(view.nodes).includes(fx.ids.budget), 'archived siblings are not listed');
    assert(!idsOf(view.nodes).includes(sameUserOther), 'another tree never leaks into the view');
  } finally {
    await deleteFixture(stranger);
    await deleteFixture(fx);
  }
});

test('GET /:id/tree — depth and limit clamp to their bounds', async () => {
  const fx = await createFixture('tree-clamp');
  const { ids } = fx;
  try {
    const wide = await getView(fx.userId, ids.root, { node: ids.root, depth: '10', limit: '500' });
    const wideIds = idsOf(wide.nodes);
    assert(wideIds.includes(ids.aKid), 'depth clamps to 3 (level 3 listed)');
    assert(
      fx.fanoutKids.every((id) => wideIds.includes(id)),
      'limit clamps to 50 (all 25 fan-out kids)'
    );
    const narrow = await getView(fx.userId, ids.root, { node: ids.fanout, depth: '0', limit: '0' });
    assert(narrow.nodes.length === 2, `limit/depth clamp to 1, got ${narrow.nodes.length}`);
    assert(narrow.next_cursor !== null, 'more children remain after a 1-row page');
  } finally {
    await deleteFixture(fx);
  }
});

test('GET /:id/tree — node naming a background task lists that task (status, no children)', async () => {
  const fx = await createFixture('tree-task-node');
  const { ids } = fx;
  try {
    await prisma.agent.update({
      where: { id: ids.root },
      data: {
        backgroundTasks: [
          {
            address: 'bg_member',
            type: 'browser',
            goal: 'Read the member number',
            status: 'completed',
            task_name: 'member_number',
            path: '/root/member_number',
          },
        ],
      },
    });
    for (const address of ['/root/member_number', `${ids.root}/bg_member`]) {
      const res = await getTree(fx.userId, ids.research, { node: address });
      assertStatus(res.status, 200, res.data);
      const view = res.data as TreeView;
      const last = view.node_path[view.node_path.length - 1];
      assert(
        last?.agent_id === '/root/member_number' && last.status === 'completed',
        `node_path ends at the task with its status, got ${JSON.stringify(view.node_path)}`
      );
      assert(
        same(
          view.node_path.slice(0, -1).map((entry) => entry.agent_id),
          [ids.root]
        ),
        `task breadcrumbs run through its owner, got ${JSON.stringify(view.node_path)}`
      );
      const node = view.nodes.find((entry) => entry.agent_id === '/root/member_number');
      assert(
        view.nodes.length === 1 &&
          node?.status === 'completed' &&
          node.child_count === 0 &&
          node.parent_agent_id === ids.root,
        `the task is listed alone as a completed leaf, got ${JSON.stringify(view.nodes)}`
      );
      assert(view.next_cursor === null, 'a task has no child pages');
    }
  } finally {
    await deleteFixture(fx);
  }
});
