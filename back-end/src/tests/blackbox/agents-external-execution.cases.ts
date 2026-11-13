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
  createTestAgent,
  type CapturedCall,
} from './agents-blackbox-harness';
import { waitFor } from '../helpers/waitFor';

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

test('external execution owns every follow-up for life: stored, never chat, Temporal or resume', async () => {
  const session = await createAnonymousSession('external-execution-followup');
  const id = randomUUID();
  const created = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(session.user.id), 'X-Agent-Execution-Mode': 'external' },
    body: JSON.stringify({ agent_id: id, goal: 'External executor follow-up ownership' }),
  });
  assertStatus(created.status, 201, created.data);
  trackedAgentIds.add(id);
  const marked = await prisma.agent.findUniqueOrThrow({ where: { id } });
  assert(marked.workflowStartPhase === 'external', 'the create transaction must persist ownership');

  const postFollowUp = async (agentId: string, captureToken: string, text: string) => {
    const posted = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
      method: 'POST',
      headers: { ...authHeaders(session.session.access_token), 'X-Capture-Token': captureToken },
      body: JSON.stringify({ message: text }),
    });
    assert(
      posted.status >= 200 && posted.status < 300,
      `follow-up must be accepted: ${posted.status}`
    );
  };
  // Storing a row broadcasts its INSERT; any other outbound call (router/generator LLMs) is chat.
  const chatCalls = async (captureToken: string): Promise<CapturedCall[]> => {
    const captures = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
    assertStatus(captures.status, 200, captures.data);
    return ((captures.data as { captures?: CapturedCall[] }).captures ?? []).filter(
      (c) => !c.url.endsWith('/realtime/v1/api/broadcast')
    );
  };

  const activeToken = `external-active-${randomUUID()}`;
  const activeText = `active follow-up ${randomUUID().slice(0, 8)}`;
  await postFollowUp(id, activeToken, activeText);
  // The executor records a terminal status; a later follow-up still belongs to it.
  const finished = await request(`${BASE_URL}/api/agents/${id}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      status: 'COMPLETED',
      progress: 1,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 1,
    }),
  });
  assertStatus(finished.status, 200, finished.data);
  const terminalToken = `external-terminal-${randomUUID()}`;
  const terminalText = `terminal follow-up ${randomUUID().slice(0, 8)}`;
  await postFollowUp(id, terminalToken, terminalText);

  // Positive control: the same route dispatches chat for an ordinary agent.
  const ordinary = await createTestAgent(session.user.id, 'Ordinary chat control');
  const controlToken = `ordinary-control-${randomUUID()}`;
  await postFollowUp(ordinary, controlToken, `control follow-up ${randomUUID().slice(0, 8)}`);
  await waitFor(
    'chat dispatch for the ordinary control agent',
    async () => (await chatCalls(controlToken)).length > 0,
    { timeoutMs: 60_000 }
  );

  // Chat for the earlier external follow-ups would have started before the control's.
  for (const token of [activeToken, terminalToken]) {
    const calls = await chatCalls(token);
    assert(
      calls.length === 0,
      `external root follow-up must not dispatch chat: ${JSON.stringify(calls.map((c) => c.url)).slice(0, 400)}`
    );
  }
  const row = await prisma.agent.findUniqueOrThrow({ where: { id } });
  assert(
    row.status === 'COMPLETED' && row.temporalWorkflowId === null,
    'an external root must not be reactivated or start Temporal'
  );
  const userRows = (await prisma.message.findMany({ where: { agentId: id, role: 'USER' } })).filter(
    (m) => m.text === activeText || m.text === terminalText
  );
  assert(userRows.length === 2, `both follow-ups must be stored, got ${userRows.length}`);
  assert(
    userRows.every((m) => !('resumedFrom' in ((m.metadata ?? {}) as Record<string, unknown>))),
    'an external root follow-up must not claim a resume'
  );
});
