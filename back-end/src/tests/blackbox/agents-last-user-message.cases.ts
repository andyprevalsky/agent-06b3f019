/**
 * Sidebar recency cases: `last_user_message_at` on GET /api/agents and the tree.
 * The left bar orders each list by run state, then by this stamp.
 *
 * Registered by `agents.blackbox.ts` (`await import('./agents-last-user-message.cases')`).
 */
import {
  BASE_URL,
  RUN_ID,
  apiKeyHeaders,
  authHeaders,
  assert,
  assertStatus,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  prisma,
  randomUUID,
  request,
  sleep,
  test,
  trackedAgentIds,
} from './agents-blackbox-harness';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordPersonMessage } from '../../providers/personMessageStamp';

// Read-after-write budget mirrors agents-sidebar-organization.cases.ts.
const LIST_POLL_ATTEMPTS = 40;
const LIST_POLL_INTERVAL_MS = 100;

/** Raw `last_user_message_at` of one row in GET /api/agents (the contract strips extras). */
async function listedLastUserMessageAt(userId: string, agentId: string): Promise<unknown> {
  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(userId) });
  assertStatus(res.status, 200, res.data);
  const rows = (res.data as { agents: Array<Record<string, unknown>> }).agents;
  const row = rows.find((a) => a.agent_id === agentId);
  assert(row !== undefined, 'Agent should appear in the active list');
  return row!.last_user_message_at;
}

test('GET / and GET /tree — last_user_message_at tracks person-authored messages only', async () => {
  const session = await createAnonymousSession('last-user-message');
  const userId = session.user.id;
  const agentId = await createTestAgent(userId, `Last user message test ${RUN_ID}`);

  // Fresh agent: no follow-up yet, so the sidebar falls back to created_at.
  assert(
    (await listedLastUserMessageAt(userId, agentId)) === null,
    'A new agent should have no last_user_message_at'
  );

  // An agent-authored USER row (A2A delivery over internal auth) is not the user.
  const a2a = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify({
      message: 'from a peer',
      role: 'USER',
      metadata: { agentMessage: true },
    }),
  });
  assertStatus(a2a.status, 201, a2a.data);
  assert(
    (await listedLastUserMessageAt(userId, agentId)) === null,
    'An agent-authored USER row must not stamp last_user_message_at'
  );

  const posted = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'a person follow-up' }),
  });
  assertStatus(posted.status, 201, posted.data);
  const sentAt = Date.parse(String((posted.data as { timestamp: unknown }).timestamp));
  let listed: unknown = null;
  for (let attempt = 0; attempt < LIST_POLL_ATTEMPTS && listed === null; attempt += 1) {
    listed = await listedLastUserMessageAt(userId, agentId);
    if (listed === null) await sleep(LIST_POLL_INTERVAL_MS);
  }
  assert(
    Date.parse(String(listed)) === sentAt,
    `List last_user_message_at ${String(listed)} should equal the posted message time`
  );

  const tree = await request(`${BASE_URL}/api/agents/tree?busId=${agentId}`, {
    headers: apiKeyHeaders(userId),
  });
  assertStatus(tree.status, 200, tree.data);
  const node = (tree.data as { agents: Array<Record<string, unknown>> }).agents.find(
    (a) => a.agent_id === agentId
  );
  assert(
    node !== undefined && Date.parse(String(node.last_user_message_at)) === sentAt,
    'Tree node should carry the same last_user_message_at'
  );

  await deleteTestAgent(agentId, userId);
});

test('recordPersonMessage — moves forward only, keeps updatedAt, never throws', async () => {
  const session = await createAnonymousSession('stamp-semantics');
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  // Seeded directly: the HTTP create path writes a title asynchronously, which
  // would move updatedAt on its own and blur the assertion below.
  await prisma.agent.create({
    data: { id: agentId, userId: session.user.id, goal: `Stamp ${RUN_ID}`, busId: agentId },
  });
  const read = () =>
    prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { updatedAt: true, lastUserMessageAt: true },
    });
  const before = await read();
  const later = new Date(Date.now() + 60_000);

  await recordPersonMessage({ agentId, timestamp: later });
  const stamped = await read();
  assert(stamped.lastUserMessageAt?.getTime() === later.getTime(), 'stamp was not written in UTC');
  assert(
    stamped.updatedAt.getTime() === before.updatedAt.getTime(),
    'the stamp must not move updatedAt (liveness and old-agent collapse read it)'
  );

  await recordPersonMessage({ agentId, timestamp: new Date(later.getTime() - 30_000) });
  await recordPersonMessage({ agentId, timestamp: new Date(Number.NaN) }); // logs, never throws
  const after = await read();
  assert(after.lastUserMessageAt?.getTime() === later.getTime(), 'stamp moved backwards');

  await prisma.agent.delete({ where: { id: agentId } });
});

test('migration backfill — live roots and children, newest person-authored message only', async () => {
  const session = await createAnonymousSession('stamp-backfill');
  const userId = session.user.id;
  const ids = {
    root: randomUUID(),
    child: randomUUID(),
    childNoMessage: randomUUID(),
    slackRoot: randomUUID(),
    flaggedRoot: randomUUID(),
    deletedRoot: randomUUID(),
  };
  for (const id of Object.values(ids)) trackedAgentIds.add(id);
  const agent = (id: string, extra: { parentAgentId?: string; deletedAt?: Date } = {}) =>
    prisma.agent.create({
      data: { id, userId, goal: `Backfill ${RUN_ID}`, busId: ids.root, ...extra },
    });
  await agent(ids.root);
  await agent(ids.child, { parentAgentId: ids.root });
  await agent(ids.childNoMessage, { parentAgentId: ids.root });
  await agent(ids.slackRoot);
  await agent(ids.flaggedRoot);
  await agent(ids.deletedRoot, { deletedAt: new Date() });

  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 0, minutes));
  const message = (
    agentId: string,
    role: 'USER' | 'TOOL',
    minutes: number,
    metadata?: Record<string, string | boolean>
  ) =>
    prisma.message.create({
      data: { agentId, role, text: `m${minutes}`, timestamp: at(minutes), metadata },
    });
  await message(ids.root, 'USER', 10);
  await message(ids.root, 'USER', 50, { agentNotification: true }); // newer, but not a person
  await message(ids.child, 'USER', 20);
  await message(ids.child, 'TOOL', 40);
  await message(ids.slackRoot, 'USER', 30, { source: 'slack_auto_rca', slackUserId: 'U1' });
  await message(ids.slackRoot, 'USER', 60, { source: 'slack_auto_rca', slackTs: '2' }); // alert
  await message(ids.flaggedRoot, 'USER', 15, { agentMessage: true });
  await message(ids.deletedRoot, 'USER', 25);

  // The migration's UPDATE, scoped to this test's agents: the local database
  // holds other tests' live agents, which an unscoped run would stamp.
  const sql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20261106120000_agent_last_user_message_at/migration.sql'
    ),
    'utf8'
  );
  const update = sql.slice(sql.indexOf('UPDATE "Agent"'));
  const unscopedTail = 'WHERE a."deletedAt" IS NULL;';
  assert(update.trimEnd().endsWith(unscopedTail), 'backfill UPDATE no longer ends as expected');
  const scoped = update
    .trimEnd()
    .replace(
      /WHERE a\."deletedAt" IS NULL;$/,
      'WHERE a."deletedAt" IS NULL AND a.id = ANY($1::text[]);'
    );
  await prisma.$executeRawUnsafe(scoped, Object.values(ids));

  const stamped = async (id: string) =>
    (
      await prisma.agent.findUniqueOrThrow({ where: { id }, select: { lastUserMessageAt: true } })
    ).lastUserMessageAt?.getTime() ?? null;
  assert((await stamped(ids.root)) === at(10).getTime(), 'root: newest person message only');
  assert((await stamped(ids.child)) === at(20).getTime(), 'live children are backfilled too');
  assert((await stamped(ids.childNoMessage)) === null, 'no person message leaves it null');
  assert(
    (await stamped(ids.slackRoot)) === at(30).getTime(),
    'Slack feedback counts, a bot-relayed occurrence does not'
  );
  assert((await stamped(ids.flaggedRoot)) === null, 'agent-authored rows never stamp');
  assert((await stamped(ids.deletedRoot)) === null, 'deleted agents are skipped');

  await prisma.message.deleteMany({ where: { agentId: { in: Object.values(ids) } } });
  await prisma.agent.deleteMany({ where: { id: { in: Object.values(ids) } } });
});
