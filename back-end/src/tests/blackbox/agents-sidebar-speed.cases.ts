/** Persisted speed must survive every sidebar listing. Registered by agents.blackbox.ts. */
import {
  BASE_URL,
  RUN_ID,
  trackedAgentIds,
  authHeaders,
  request,
  assertStatus,
  assert,
  createAnonymousSession,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';

test('sidebar active search and archive preserve persisted speeds over the legacy flag', async () => {
  const session = await createAnonymousSession('sidebar-persisted-speeds');
  const needle = `persisted-speeds-${RUN_ID}`;
  const active = new Map<string, string>();
  const archived = new Map<string, string>();
  for (const speed of ['standard', 'fast', 'ultrafast'] as const) {
    for (const isArchived of [false, true]) {
      const id = randomUUID();
      trackedAgentIds.add(id);
      await prisma.agent.create({
        data: {
          id,
          userId: session.user.id,
          goal: needle,
          status: 'ACTIVE',
          busId: id,
          speed,
          fastModeCacheEnabled: speed === 'standard',
          deletedAt: isArchived ? new Date() : null,
        },
      });
      (isArchived ? archived : active).set(id, speed);
    }
  }
  for (const [route, expected] of [
    ['/api/agents', active],
    [`/api/agents/search?q=${encodeURIComponent(needle)}`, active],
    ['/api/agents/archived', archived],
  ] as const) {
    const res = await request(`${BASE_URL}${route}`, {
      headers: authHeaders(session.session.access_token),
    });
    assertStatus(res.status, 200, res.data);
    const rows = (res.data as { agents: Array<{ agent_id: string; speed?: string }> }).agents;
    for (const [id, speed] of expected) {
      assert(
        rows.find((row) => row.agent_id === id)?.speed === speed,
        `${route} must retain persisted ${speed} instead of the conflicting legacy flag`
      );
    }
  }
});
