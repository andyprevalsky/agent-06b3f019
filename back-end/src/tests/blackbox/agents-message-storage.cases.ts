import {
  BASE_URL,
  PostMessageResponse,
  apiKeyHeaders,
  request,
  assertStatus,
  assertSchema,
  assert,
  createAnonymousSession,
  createTestAgent,
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
  const agentId = await createTestAgent(session.user.id, 'NUL character message test');
  await prisma.agent.update({ where: { id: agentId }, data: { temporalWorkflowId: agentId } });
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
