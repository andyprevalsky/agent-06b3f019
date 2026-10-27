/**
 * Sidebar organization cases: rename (PATCH title), pin (PATCH pinned),
 * archive (DELETE /:id) and unarchive (POST /:id/unarchive), plus the bounds
 * and ownership scoping of GET /archived.
 *
 * Registered by `agents.blackbox.ts` (`await import('./agents-sidebar-organization.cases')`).
 * A `.cases.ts` file is NOT auto-discovered — only `*.blackbox.ts` is — so a case
 * file that nobody imports defines tests that never run and still reports green.
 */
import {
  BASE_URL,
  FAKE_UUID,
  RUN_ID,
  trackedAgentIds,
  ErrorResponse,
  ListAgentsResponse,
  ArchivedAgentsResponse,
  AgentListItem,
  GetAgentResponse,
  UpdateAgentResponse,
  SuccessResponse,
  authHeaders,
  apiKeyHeaders,
  request,
  assertStatus,
  assertSchema,
  assert,
  sleep,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  withTransientDbRetry,
  test,
  prisma,
  randomUUID,
  z,
} from './agents-blackbox-harness';
import {
  ARCHIVED_AGENTS_DEFAULT_LIMIT,
  ARCHIVED_AGENTS_MAX_LIMIT,
} from '../../domains/agents/types';
import { backfillArchivedAgentStatus } from '../../providers/archivedAgentStatusBackfill';

type AgentListRow = z.infer<typeof AgentListItem>;

// Read-after-write can briefly race the Prisma connection pool (the read may
// land on a connection whose snapshot predates the just-committed write), so
// list assertions poll instead of asserting a single immediate read. Budget
// mirrors the read-after-write case in agents-lifecycle.cases.ts (~4s), which is
// generous enough for the c8-instrumented coverage backend.
const LIST_POLL_ATTEMPTS = 40;
const LIST_POLL_INTERVAL_MS = 100;

interface AgentRowOverrides {
  title?: string | null;
  pinnedAt?: Date | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  isBenchmark?: boolean;
  statusMessage?: string;
  parentAgentId?: string;
}

/**
 * Create an agent row directly, bypassing POST /api/agents.
 *
 * Two reasons the HTTP create path is wrong for some cases here:
 *  1. It fires `generateAgentTitle` for ROOT agents, which writes `title`
 *     asynchronously. Any case that asserts `title === null` would race it.
 *  2. `createdAt`/`deletedAt` cannot be chosen, and the ordering and limit cases
 *     need exact, non-adjacent timestamps rather than sleep-separated ones.
 *
 * The routes under test (PATCH /:id, GET /, GET /archived, POST /:id/unarchive)
 * are still exercised over HTTP — only the fixture is seeded directly, matching
 * the existing prisma-seeded cases in agents-cost-resume.cases.ts.
 */
async function createAgentRow(
  userId: string,
  goal: string,
  overrides: AgentRowOverrides = {}
): Promise<string> {
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-sidebar-agent-row', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal,
        status: 'ACTIVE',
        busId: agentId,
        ...overrides,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });
  return agentId;
}

async function patchAgent(
  agentId: string,
  userId: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown; headers: Headers }> {
  return request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify(body),
  });
}

/** Read the stored title/pin/archive state back through GET /api/agents/:id. */
async function fetchAgentTitle(
  agentId: string,
  userId: string,
  label: string
): Promise<string | null> {
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(userId),
  });
  assertStatus(res.status, 200, res.data);
  return assertSchema(GetAgentResponse, res.data, label).agent.title;
}

async function fetchAgentList(userId: string, label: string): Promise<AgentListRow[]> {
  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(userId) });
  assertStatus(res.status, 200, res.data);
  return assertSchema(ListAgentsResponse, res.data, label).agents;
}

async function fetchArchivedList(
  userId: string,
  label: string,
  query = ''
): Promise<AgentListRow[]> {
  const res = await request(`${BASE_URL}/api/agents/archived${query}`, {
    headers: apiKeyHeaders(userId),
  });
  assertStatus(res.status, 200, res.data);
  return assertSchema(ArchivedAgentsResponse, res.data, label).agents;
}

/** Poll GET /api/agents until `predicate` holds or the poll budget is spent. */
async function waitForAgentList(
  userId: string,
  label: string,
  predicate: (agents: AgentListRow[]) => boolean
): Promise<AgentListRow[]> {
  let agents = await fetchAgentList(userId, label);
  for (let attempt = 0; attempt < LIST_POLL_ATTEMPTS && !predicate(agents); attempt += 1) {
    await sleep(LIST_POLL_INTERVAL_MS);
    agents = await fetchAgentList(userId, label);
  }
  return agents;
}

/** Poll GET /api/agents/archived until `predicate` holds or the budget is spent. */
async function waitForArchivedList(
  userId: string,
  label: string,
  predicate: (agents: AgentListRow[]) => boolean
): Promise<AgentListRow[]> {
  let agents = await fetchArchivedList(userId, label);
  for (let attempt = 0; attempt < LIST_POLL_ATTEMPTS && !predicate(agents); attempt += 1) {
    await sleep(LIST_POLL_INTERVAL_MS);
    agents = await fetchArchivedList(userId, label);
  }
  return agents;
}

// ========================= PATCH /:id — rename =============================

test('PATCH /:id — title rename persists in the response and in GET /', async () => {
  const session = await createAnonymousSession('rename-title');
  const goal = `Rename title test ${RUN_ID}`;
  const agentId = await createTestAgent(session.user.id, goal);
  const title = `Sidebar Label ${randomUUID().slice(0, 8)}`;

  const res = await patchAgent(agentId, session.user.id, { title });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id title');
  assert(body.agent.title === title, `Expected title "${title}", got "${body.agent.title}"`);
  assert(body.agent.goal === goal, 'Rename must not rewrite the goal');

  // `generateAgentTitle` fires from the create path but writes under a
  // `title: null` guard, so it can never clobber this rename.
  const agents = await waitForAgentList(session.user.id, 'list after rename', (rows) =>
    rows.some((a) => a.agent_id === agentId && a.title === title)
  );
  const listed = agents.find((a) => a.agent_id === agentId);
  assert(listed, 'Renamed agent should appear in the active list');
  assert(listed!.title === title, `Expected list title "${title}", got "${listed!.title}"`);
  assert(listed!.goal === goal, 'List goal must be unchanged by a rename');

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — title: null clears the rename', async () => {
  const session = await createAnonymousSession('clear-title');
  // Seeded directly: the HTTP create path would race generateAgentTitle, which
  // writes a title exactly when `title` is null — the state asserted below.
  const agentId = await createAgentRow(session.user.id, `Clear title test ${RUN_ID}`, {
    title: 'Old Label',
  });

  const res = await patchAgent(agentId, session.user.id, { title: null });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id title null');
  assert(body.agent.title === null, `Expected cleared title, got "${body.agent.title}"`);

  const agents = await waitForAgentList(session.user.id, 'list after clear', (rows) =>
    rows.some((a) => a.agent_id === agentId && a.title === null)
  );
  const listed = agents.find((a) => a.agent_id === agentId);
  assert(listed, 'Agent should still appear in the active list after clearing its title');
  assert(listed!.title === null, `Expected null list title, got "${listed!.title}"`);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — title over 80 chars → 400, exactly 80 accepted', async () => {
  const session = await createAnonymousSession('title-max');
  const agentId = await createAgentRow(session.user.id, `Title bound test ${RUN_ID}`);

  const atLimit = 'x'.repeat(80);
  const accepted = await patchAgent(agentId, session.user.id, { title: atLimit });
  assertStatus(accepted.status, 200, accepted.data);
  const acceptedBody = assertSchema(UpdateAgentResponse, accepted.data, 'PATCH /:id title 80');
  assert(acceptedBody.agent.title === atLimit, 'An 80-char title must be stored verbatim');

  const rejected = await patchAgent(agentId, session.user.id, { title: 'x'.repeat(81) });
  assertStatus(rejected.status, 400, rejected.data);
  assertSchema(ErrorResponse, rejected.data, 'PATCH /:id title 81');

  // The rejected write must not have partially landed.
  const stored = await fetchAgentTitle(agentId, session.user.id, 'GET /:id title unchanged');
  assert(stored === atLimit, `Rejected rename must leave the stored title alone, got "${stored}"`);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — empty or whitespace-only title → 400', async () => {
  const session = await createAnonymousSession('title-empty');
  const agentId = await createAgentRow(session.user.id, `Empty title test ${RUN_ID}`, {
    title: 'Keep Me',
  });

  for (const title of ['', '   ', '\t\n']) {
    const res = await patchAgent(agentId, session.user.id, { title });
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, `PATCH /:id title ${JSON.stringify(title)}`);
  }

  const stored = await fetchAgentTitle(agentId, session.user.id, 'GET /:id title kept');
  assert(stored === 'Keep Me', `Rejected blank rename must keep the old title, got "${stored}"`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= PATCH /:id — pin ================================

test('PATCH /:id — pinned: true sets pinned_at and sorts ahead of a newer agent', async () => {
  const session = await createAnonymousSession('pin-order');
  // Exact, non-adjacent createdAt values: the ordering contract is
  // [pinnedAt desc nulls last, createdAt desc], so recency must be unambiguous.
  const now = Date.now();
  const olderId = await createAgentRow(session.user.id, `Older agent ${RUN_ID}`, {
    createdAt: new Date(now - 60_000),
  });
  const newerId = await createAgentRow(session.user.id, `Newer agent ${RUN_ID}`, {
    createdAt: new Date(now),
  });

  const before = await waitForAgentList(session.user.id, 'list before pin', (rows) =>
    [olderId, newerId].every((id) => rows.some((a) => a.agent_id === id))
  );
  assert(
    before.findIndex((a) => a.agent_id === newerId) <
      before.findIndex((a) => a.agent_id === olderId),
    'Unpinned agents must default to newest-first'
  );
  assert(
    before.every((a) => a.pinned_at === null),
    'Freshly created agents must not be pinned'
  );

  const res = await patchAgent(olderId, session.user.id, { pinned: true });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id pinned true');
  assert(body.agent.pinned_at !== null, 'pinned: true must set pinned_at');

  const after = await waitForAgentList(
    session.user.id,
    'list after pin',
    (rows) => rows.findIndex((a) => a.agent_id === olderId) === 0
  );
  const pinnedIdx = after.findIndex((a) => a.agent_id === olderId);
  const unpinnedIdx = after.findIndex((a) => a.agent_id === newerId);
  assert(pinnedIdx >= 0 && unpinnedIdx >= 0, 'Both agents should still be listed');
  assert(
    pinnedIdx < unpinnedIdx,
    `Pinned agent must sort ahead of the newer unpinned agent (pinned=${pinnedIdx}, unpinned=${unpinnedIdx})`
  );
  assert(after[pinnedIdx].pinned_at !== null, 'Pinned row must expose a non-null pinned_at');
  assert(after[unpinnedIdx].pinned_at === null, 'Unpinned row must expose a null pinned_at');

  await deleteTestAgent(olderId, session.user.id);
  await deleteTestAgent(newerId, session.user.id);
});

test('PATCH /:id — pinned: false clears pinned_at and restores recency order', async () => {
  const session = await createAnonymousSession('unpin-order');
  const now = Date.now();
  const olderId = await createAgentRow(session.user.id, `Older unpin agent ${RUN_ID}`, {
    createdAt: new Date(now - 60_000),
    pinnedAt: new Date(now),
  });
  const newerId = await createAgentRow(session.user.id, `Newer unpin agent ${RUN_ID}`, {
    createdAt: new Date(now),
  });

  const pinned = await waitForAgentList(
    session.user.id,
    'list while pinned',
    (rows) => rows.findIndex((a) => a.agent_id === olderId) === 0
  );
  assert(pinned[0]?.agent_id === olderId, 'Pinned agent should start at the top');

  const res = await patchAgent(olderId, session.user.id, { pinned: false });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id pinned false');
  assert(body.agent.pinned_at === null, 'pinned: false must clear pinned_at');

  const after = await waitForAgentList(
    session.user.id,
    'list after unpin',
    (rows) => rows.findIndex((a) => a.agent_id === newerId) === 0
  );
  assert(
    after.findIndex((a) => a.agent_id === newerId) < after.findIndex((a) => a.agent_id === olderId),
    'Unpinning must restore newest-first ordering'
  );
  assert(
    after.every((a) => a.pinned_at === null),
    'No agent should remain pinned after unpin'
  );

  await deleteTestAgent(olderId, session.user.id);
  await deleteTestAgent(newerId, session.user.id);
});

// ========================= DELETE /:id — archive ===========================

test('DELETE /:id — archives out of GET / and into GET /archived', async () => {
  const session = await createAnonymousSession('archive-move');
  const goal = `Archive move test ${RUN_ID}`;
  const agentId = await createTestAgent(session.user.id, goal);
  const title = `Archived Label ${randomUUID().slice(0, 8)}`;

  const renamed = await patchAgent(agentId, session.user.id, { title });
  assertStatus(renamed.status, 200, renamed.data);

  const del = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(del.status, 204, del.data);

  const active = await waitForAgentList(
    session.user.id,
    'active list after archive',
    (rows) => !rows.some((a) => a.agent_id === agentId)
  );
  assert(
    !active.some((a) => a.agent_id === agentId),
    'Archived agent must disappear from the active list'
  );

  const archived = await waitForArchivedList(
    session.user.id,
    'archived list after archive',
    (rows) => rows.some((a) => a.agent_id === agentId)
  );
  const row = archived.find((a) => a.agent_id === agentId);
  assert(row, 'Archived agent must appear in GET /archived');
  assert(row!.archived_at !== null, 'Archived row must expose a non-null archived_at');
  assert(row!.title === title, `Archiving must preserve the title, got "${row!.title}"`);
  assert(row!.goal === goal, 'Archiving must preserve the goal');
});

test('DELETE /:id — archived running agents and their children become terminal', async () => {
  const session = await createAnonymousSession('archive-terminal');
  const parentId = await createAgentRow(session.user.id, `Archive terminal parent ${RUN_ID}`);
  const childId = await createAgentRow(session.user.id, `Archive terminal child ${RUN_ID}`, {
    status: 'PAUSED',
    parentAgentId: parentId,
  });
  const doneId = await createAgentRow(session.user.id, `Archive terminal done ${RUN_ID}`, {
    status: 'COMPLETED',
    statusMessage: 'finished',
  });

  for (const agentId of [parentId, doneId]) {
    const del = await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: apiKeyHeaders(session.user.id),
    });
    assertStatus(del.status, 204, del.data);
  }

  const rows = await prisma.agent.findMany({
    where: { id: { in: [parentId, childId, doneId] } },
    select: { id: true, status: true, statusMessage: true, deletedAt: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const agentId of [parentId, childId]) {
    const row = byId.get(agentId);
    assert(row?.deletedAt !== null, `${agentId} must be archived`);
    assert(
      row?.status === 'FAILED' && row.statusMessage === 'Archived by user',
      `an archived running agent must become FAILED/"Archived by user", got ${row?.status}/${row?.statusMessage}`
    );
  }
  const done = byId.get(doneId);
  assert(
    done?.status === 'COMPLETED' && done.statusMessage === 'finished',
    `archiving must keep an already-terminal status, got ${done?.status}/${done?.statusMessage}`
  );

  const archived = await waitForArchivedList(session.user.id, 'archived terminal rows', (list) =>
    list.some((a) => a.agent_id === parentId)
  );
  assert(
    archived.some((a) => a.agent_id === parentId),
    'Archived parent must stay listed in GET /archived'
  );
});

test('archived-agent status backfill settles only archived non-terminal rows, idempotently', async () => {
  const session = await createAnonymousSession('archive-backfill');
  const staleId = await createAgentRow(session.user.id, `Archive backfill stale ${RUN_ID}`, {
    deletedAt: new Date(),
  });
  const liveId = await createAgentRow(session.user.id, `Archive backfill live ${RUN_ID}`);
  const benchmarkId = await createAgentRow(session.user.id, `Archive backfill bench ${RUN_ID}`, {
    deletedAt: new Date(),
    isBenchmark: true,
  });
  const heldId = await createAgentRow(session.user.id, `Archive backfill held ${RUN_ID}`, {
    deletedAt: new Date(),
  });
  await prisma.purchaseSpend.create({
    data: {
      userId: session.user.id,
      agentId: heldId,
      status: 'HELD',
      fingerprint: `archive-backfill-${randomUUID()}`,
      merchant: 'backfill fixture',
      lineItemsJson: [],
      totalCents: 100,
    },
  });
  const skeletonId = await createAgentRow(
    'benchmark-hub-ancestors',
    `Archive backfill skeleton ${RUN_ID}`,
    { deletedAt: new Date() }
  );

  const dryRun = await backfillArchivedAgentStatus({ execute: false });
  assert(dryRun.pendingBefore >= 1 && dryRun.updated === 0, 'dry run must count but not write');
  const first = await backfillArchivedAgentStatus({ execute: true, batchSize: 1 });
  assert(first.updated >= 1, `backfill must settle the stale row, got ${JSON.stringify(first)}`);
  // Idempotency is asserted on this test's own row: concurrent domains share
  // the database and may archive agents between runs, so a global "nothing
  // left" count races them.
  const settledAt = (
    await prisma.agent.findUniqueOrThrow({ where: { id: staleId }, select: { updatedAt: true } })
  ).updatedAt;
  await backfillArchivedAgentStatus({ execute: true });
  const afterSecond = await prisma.agent.findUniqueOrThrow({
    where: { id: staleId },
    select: { updatedAt: true },
  });
  assert(
    afterSecond.updatedAt.getTime() === settledAt.getTime(),
    'a second run must not touch an already-settled row'
  );

  const rows = await prisma.agent.findMany({
    where: { id: { in: [staleId, liveId, benchmarkId, heldId, skeletonId] } },
    select: { id: true, status: true, statusMessage: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert(
    byId.get(staleId)?.status === 'FAILED' &&
      byId.get(staleId)?.statusMessage === 'Archived by user',
    'the archived ACTIVE row must become FAILED/"Archived by user"'
  );
  assert(byId.get(liveId)?.status === 'ACTIVE', 'a non-archived ACTIVE row must be untouched');
  for (const [agentId, why] of [
    [benchmarkId, 'an isBenchmark agent (benchmark cleanup has its own owner)'],
    [heldId, 'an agent holding a HELD purchase spend (no money may move)'],
    [skeletonId, 'a benchmark-hub ancestor skeleton (breadcrumb mirror)'],
  ] as const) {
    assert(byId.get(agentId)?.status === 'ACTIVE', `the backfill must skip ${why}`);
  }
  await prisma.purchaseSpend.deleteMany({ where: { agentId: heldId } });
});

// ========================= POST /:id/unarchive =============================

test('POST /:id/unarchive — restores the agent to the active list', async () => {
  const session = await createAnonymousSession('unarchive-restore');
  const agentId = await createTestAgent(session.user.id, `Unarchive test ${RUN_ID}`);
  await deleteTestAgent(agentId, session.user.id);
  await waitForArchivedList(session.user.id, 'archived before unarchive', (rows) =>
    rows.some((a) => a.agent_id === agentId)
  );

  const res = await request(`${BASE_URL}/api/agents/${agentId}/unarchive`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SuccessResponse, res.data, 'POST /:id/unarchive');
  assert(body.success === true, 'Unarchive should report success');

  const active = await waitForAgentList(session.user.id, 'active after unarchive', (rows) =>
    rows.some((a) => a.agent_id === agentId)
  );
  const restored = active.find((a) => a.agent_id === agentId);
  assert(restored, 'Unarchived agent must return to the active list');
  assert(restored!.archived_at === null, 'Restored row must expose a null archived_at');

  const archived = await waitForArchivedList(
    session.user.id,
    'archived after unarchive',
    (rows) => !rows.some((a) => a.agent_id === agentId)
  );
  assert(
    !archived.some((a) => a.agent_id === agentId),
    'Unarchived agent must leave GET /archived'
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/unarchive — non-archived agent → 404', async () => {
  const session = await createAnonymousSession('unarchive-active');
  const agentId = await createAgentRow(session.user.id, `Unarchive active test ${RUN_ID}`);

  const res = await request(`${BASE_URL}/api/agents/${agentId}/unarchive`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/unarchive not archived');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/unarchive — unknown id → 404', async () => {
  const session = await createAnonymousSession('unarchive-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/unarchive`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/unarchive unknown');
});

test('POST /:id/unarchive — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/unarchive`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
});

test("POST /:id/unarchive — another user's archived agent → 404", async () => {
  const sessionA = await createAnonymousSession('unarchive-iso-a');
  const sessionB = await createAnonymousSession('unarchive-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, `Unarchive isolation test ${RUN_ID}`);
  await deleteTestAgent(agentId, sessionA.user.id);

  // JWT, not the API key: X-API-Key is INTERNAL auth (hybridAuth sets
  // isInternal even with X-User-Id), and the route deliberately drops the owner
  // filter for internal callers. Only a JWT exercises ownership scoping.
  const res = await request(`${BASE_URL}/api/agents/${agentId}/unarchive`, {
    method: 'POST',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/unarchive cross-user');

  // ...and user A's agent is still archived, not restored by the failed attempt.
  const archived = await fetchArchivedList(sessionA.user.id, 'archived after cross-user attempt');
  assert(
    archived.some((a) => a.agent_id === agentId),
    "A rejected cross-user unarchive must leave the owner's agent archived"
  );
});

// ========================= GET /archived ===================================

test('GET /archived — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/archived`);
  assertStatus(res.status, 401, res.data);
});

test('GET /archived — new user sees empty list', async () => {
  const session = await createAnonymousSession('archived-empty');
  const agents = await fetchArchivedList(session.user.id, 'GET /archived empty');
  assert(agents.length === 0, `Expected 0 archived agents, got ${agents.length}`);
});

test('GET /archived — tenant isolation: user B cannot see user A archived agents', async () => {
  const sessionA = await createAnonymousSession('archived-iso-a');
  const sessionB = await createAnonymousSession('archived-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, `Archived isolation test ${RUN_ID}`);
  await deleteTestAgent(agentId, sessionA.user.id);
  await waitForArchivedList(sessionA.user.id, 'archived owner view', (rows) =>
    rows.some((a) => a.agent_id === agentId)
  );

  const res = await request(`${BASE_URL}/api/agents/archived`, {
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ArchivedAgentsResponse, res.data, 'GET /archived isolation');
  assert(
    !body.agents.some((a) => a.agent_id === agentId),
    "User B must not see user A's archived agents"
  );
});

test('GET /archived — newest archived first and ?limit= is honored', async () => {
  const session = await createAnonymousSession('archived-limit');
  const now = Date.now();
  // Seeded directly so deletedAt ordering is exact rather than clock-dependent.
  const oldestId = await createAgentRow(session.user.id, `Archived oldest ${RUN_ID}`, {
    deletedAt: new Date(now - 120_000),
  });
  const middleId = await createAgentRow(session.user.id, `Archived middle ${RUN_ID}`, {
    deletedAt: new Date(now - 60_000),
  });
  const newestId = await createAgentRow(session.user.id, `Archived newest ${RUN_ID}`, {
    deletedAt: new Date(now),
  });

  const all = await waitForArchivedList(
    session.user.id,
    'GET /archived all',
    (rows) => rows.length === 3
  );
  assert(all.length === 3, `Expected 3 archived agents, got ${all.length}`);
  assert(
    all.map((a) => a.agent_id).join(',') === [newestId, middleId, oldestId].join(','),
    `Expected newest-archived-first order, got ${all.map((a) => a.goal).join(', ')}`
  );

  const limited = await fetchArchivedList(session.user.id, 'GET /archived limit=2', '?limit=2');
  assert(limited.length === 2, `Expected limit=2 to return 2 rows, got ${limited.length}`);
  assert(
    limited.map((a) => a.agent_id).join(',') === [newestId, middleId].join(','),
    'limit must truncate the tail of the newest-first ordering, not a random slice'
  );

  const single = await fetchArchivedList(session.user.id, 'GET /archived limit=1', '?limit=1');
  assert(single.length === 1, `Expected limit=1 to return 1 row, got ${single.length}`);
  assert(single[0].agent_id === newestId, 'limit=1 must return the most recently archived agent');
});

test('GET /archived — out-of-range or non-numeric limit → 400', async () => {
  const session = await createAnonymousSession('archived-limit-bounds');

  for (const limit of ['0', String(ARCHIVED_AGENTS_MAX_LIMIT + 1), '-1', '1.5', 'abc']) {
    const res = await request(`${BASE_URL}/api/agents/archived?limit=${limit}`, {
      headers: apiKeyHeaders(session.user.id),
    });
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, `GET /archived limit=${limit}`);
  }

  // The documented bounds themselves are valid.
  for (const limit of [1, ARCHIVED_AGENTS_MAX_LIMIT]) {
    const res = await request(`${BASE_URL}/api/agents/archived?limit=${limit}`, {
      headers: apiKeyHeaders(session.user.id),
    });
    assertStatus(res.status, 200, res.data);
    assertSchema(ArchivedAgentsResponse, res.data, `GET /archived limit=${limit} ok`);
  }
});

test('GET /archived — omitted limit caps at ARCHIVED_AGENTS_DEFAULT_LIMIT', async () => {
  const session = await createAnonymousSession('archived-default-cap');
  const total = ARCHIVED_AGENTS_DEFAULT_LIMIT + 1;
  const now = Date.now();
  // Bulk-seeded: the point of this case is the bound, and 101 HTTP creates would
  // spend minutes and real LLM budget to assert a `take`.
  const rows = Array.from({ length: total }, (_, index) => ({
    id: randomUUID(),
    userId: session.user.id,
    goal: `Archive cap ${index} ${RUN_ID}`,
    deletedAt: new Date(now - index * 1000),
  }));
  const ids = rows.map((row) => row.id);
  await withTransientDbRetry('create-archive-cap-rows', async () => {
    await prisma.agent.createMany({ data: rows, skipDuplicates: true });
  });

  try {
    const defaulted = await waitForArchivedList(
      session.user.id,
      'GET /archived default cap',
      (agents) => agents.length === ARCHIVED_AGENTS_DEFAULT_LIMIT
    );
    assert(
      defaulted.length === ARCHIVED_AGENTS_DEFAULT_LIMIT,
      `Expected the default cap of ${ARCHIVED_AGENTS_DEFAULT_LIMIT}, got ${defaulted.length}`
    );
    assert(
      defaulted[0].agent_id === ids[0],
      'The default cap must keep the newest-archived rows, not an arbitrary page'
    );

    // The rows beyond the default cap exist — the cap is a `take`, not a filter.
    const raised = await fetchArchivedList(
      session.user.id,
      'GET /archived raised limit',
      `?limit=${ARCHIVED_AGENTS_MAX_LIMIT}`
    );
    assert(
      raised.length === total,
      `Expected limit=${ARCHIVED_AGENTS_MAX_LIMIT} to return all ${total} rows, got ${raised.length}`
    );
  } finally {
    await withTransientDbRetry('cleanup-archive-cap-rows', async () => {
      await prisma.agent.deleteMany({ where: { id: { in: ids } } });
    });
  }
});
