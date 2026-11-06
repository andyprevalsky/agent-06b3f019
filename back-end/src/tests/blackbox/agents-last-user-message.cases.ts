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
