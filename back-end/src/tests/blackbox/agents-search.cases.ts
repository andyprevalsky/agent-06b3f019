/**
 * Search cases for GET /api/agents/search.
 *
 * The endpoint owns full-chat search: it must match top-level active chats by
 * title, goal, or Message.text while preserving tenant and archive boundaries.
 */
import {
  BASE_URL,
  RUN_ID,
  ErrorResponse,
  ListAgentsResponse,
  apiKeyHeaders,
  assert,
  assertSchema,
  assertStatus,
  authHeaders,
  createAnonymousSession,
  prisma,
  randomUUID,
  request,
  test,
  trackedAgentIds,
  withTransientDbRetry,
} from './agents-blackbox-harness';

async function seedSearchAgent({
  userId,
  goal,
  title = null,
  message,
  parentAgentId = null,
  deletedAt = null,
}: {
  userId: string;
  goal: string;
  title?: string | null;
  message?: string;
  parentAgentId?: string | null;
  deletedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  trackedAgentIds.add(id);
  await withTransientDbRetry('seed-search-agent', async () => {
    await prisma.agent.create({
      data: { id, userId, goal, title, parentAgentId, deletedAt, busId: id, status: 'ACTIVE' },
    });
    if (message !== undefined) {
      await prisma.message.create({ data: { agentId: id, text: message, role: 'USER' } });
    }
  });
  return id;
}

test('GET /search — matches title, goal, and message text within the active top-level tenant', async () => {
  const owner = await createAnonymousSession('agent-search-owner');
  const stranger = await createAnonymousSession('agent-search-stranger');
  const needle = `Saxophone-${RUN_ID}`;

  const contentId = await seedSearchAgent({
    userId: owner.user.id,
    goal: 'Plan the team offsite',
    title: 'Team offsite',
    message: `Please remember the ${needle} rental`,
  });
  const goalId = await seedSearchAgent({
    userId: owner.user.id,
    goal: `Research ${needle} teachers`,
  });
  const titleId = await seedSearchAgent({
    userId: owner.user.id,
    goal: 'Compare local instructors',
    title: `${needle} lessons`,
  });
  await seedSearchAgent({
    userId: owner.user.id,
    goal: 'Archived matching chat',
    message: needle,
    deletedAt: new Date(),
  });
  await seedSearchAgent({
    userId: owner.user.id,
    goal: 'Matching child chat',
    message: needle,
    parentAgentId: contentId,
  });
  await seedSearchAgent({
    userId: stranger.user.id,
    goal: 'Another tenant matching chat',
    message: needle,
  });

  const res = await request(`${BASE_URL}/api/agents/search?q=${encodeURIComponent(needle)}`, {
    headers: authHeaders(owner.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListAgentsResponse, res.data, 'GET /search matches');
  const ids = new Set(body.agents.map((agent) => agent.agent_id));

  assert(ids.size === 3, `Expected exactly 3 owned active root matches, got ${ids.size}`);
  assert(ids.has(contentId), 'Message-only match must be returned');
  assert(ids.has(goalId), 'Goal match must be returned');
  assert(ids.has(titleId), 'Title match must be returned');
});

test('GET /search — validates authentication and query bounds', async () => {
  const unauthenticated = await request(`${BASE_URL}/api/agents/search?q=rose`);
  assertStatus(unauthenticated.status, 401, unauthenticated.data);

  const owner = await createAnonymousSession('agent-search-validation');
  for (const query of ['', '   ', 'x'.repeat(201)]) {
    const res = await request(`${BASE_URL}/api/agents/search?q=${encodeURIComponent(query)}`, {
      headers: apiKeyHeaders(owner.user.id),
    });
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, `GET /search invalid q=${query.length}`);
  }
});
