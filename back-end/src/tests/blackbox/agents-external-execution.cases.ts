import {
  BASE_URL,
  apiKeyHeaders,
  authHeaders,
  request,
  assert,
  assertStatus,
  createAnonymousSession,
  trackedAgentIds,
  prisma,
  randomUUID,
  test,
  sleep,
  type CapturedCall,
} from './agents-blackbox-harness';

test('external execution persists a detached Message owner without launching chat or Temporal', async () => {
  const session = await createAnonymousSession('external-execution');
  const id = randomUUID();
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(session.user.id), 'X-Agent-Execution-Mode': 'external' },
    body: JSON.stringify({
      agent_id: id,
      goal: 'External executor identity',
      fast_mode_cache_enabled: false,
      memory_enabled: false,
    }),
  });
  assertStatus(res.status, 201, res.data);
  trackedAgentIds.add(id);
  const row = await prisma.agent.findUniqueOrThrow({ where: { id } });
  assert(row.status === 'ACTIVE', 'external execution must persist ACTIVE before responding');
  assert(
    row.temporalWorkflowId === null && !row.temporalWorkflowStartPending,
    'must not start a workflow'
  );
  assert(row.parentAgentId === null && row.busId === id, 'must be a detached root');
  assert(
    (res.data as { execution_mode?: string }).execution_mode === 'external',
    'must acknowledge external mode'
  );
  await prisma.message.create({
    data: { agentId: id, text: 'session initialization', role: 'TOOL', timestamp: new Date() },
  });
  const messages = await prisma.message.findMany({ where: { agentId: id } });
  assert(
    messages.some((message) => message.text === 'session initialization'),
    'session Message FK must resolve'
  );
  assert(
    !messages.some((message) => message.role === 'ASSISTANT'),
    'identity creation must not run chat'
  );
});

test('external execution rejects public authentication and incompatible launch intent before persistence', async () => {
  const session = await createAnonymousSession('external-execution-denied');
  for (const scenario of [
    { headers: authHeaders(session.session.access_token), extra: {}, expected: 403 },
    { headers: apiKeyHeaders(session.user.id), extra: { start_phase: 'execute' }, expected: 400 },
  ]) {
    const id = randomUUID();
    const res = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: { ...scenario.headers, 'X-Agent-Execution-Mode': 'external' },
      body: JSON.stringify({ agent_id: id, goal: 'Rejected external executor', ...scenario.extra }),
    });
    assertStatus(res.status, scenario.expected, res.data);
    assert(
      (await prisma.agent.findUnique({ where: { id } })) === null,
      'rejection must not persist an Agent'
    );
  }
});

test('external execution owns follow-up messages until terminal: stored, no chat or Temporal', async () => {
  const session = await createAnonymousSession('external-execution-followup');
  const id = randomUUID();
  const created = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(session.user.id), 'X-Agent-Execution-Mode': 'external' },
    body: JSON.stringify({ agent_id: id, goal: 'External executor follow-up ownership' }),
  });
  assertStatus(created.status, 201, created.data);
  trackedAgentIds.add(id);
  const captureToken = `external-followup-${randomUUID()}`;
  const text = `owner follow-up ${randomUUID().slice(0, 8)}`;
  const posted = await request(`${BASE_URL}/api/agents/${id}/messages`, {
    method: 'POST',
    headers: { ...authHeaders(session.session.access_token), 'X-Capture-Token': captureToken },
    body: JSON.stringify({ message: text }),
  });
  assert(
    posted.status >= 200 && posted.status < 300,
    `follow-up must be accepted: ${posted.status}`
  );
  await sleep(3000);
  const captures = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(captures.status, 200, captures.data);
  // Storing the row broadcasts its INSERT; anything else (router/generator LLMs) is chat dispatch.
  const calls = ((captures.data as { captures?: CapturedCall[] }).captures ?? []).filter(
    (c) => !c.url.endsWith('/realtime/v1/api/broadcast')
  );
  assert(
    calls.length === 0,
    `external root follow-up must not dispatch chat: ${JSON.stringify(calls.map((c) => c.url)).slice(0, 400)}`
  );
  const row = await prisma.agent.findUniqueOrThrow({ where: { id } });
  assert(row.status === 'ACTIVE' && row.temporalWorkflowId === null, 'must not start Temporal');
  const messages = await prisma.message.findMany({ where: { agentId: id } });
  assert(
    messages.some((m) => m.role === 'USER' && m.text === text),
    'follow-up row must be stored'
  );
  assert(!messages.some((m) => m.role === 'ASSISTANT'), 'chat must not reply beside the executor');
});
