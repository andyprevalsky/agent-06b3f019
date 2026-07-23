import {
  BASE_URL,
  FAKE_UUID,
  GetAgentResponse,
  PostMessageResponse,
  StatusResponse,
  UpdateStatusResponse,
  authHeaders,
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

test('POST /:id/messages — deployment fence preserves success and blocks stale writes', async () => {
  const session = await createAnonymousSession('msg-tool-terminal-sticky');
  const agentId = await createTestAgent(session.user.id, 'Tool terminal race test');
  const toolCallId = `terminal-sticky-${randomUUID().slice(0, 8)}`;
  const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: agentId },
  });
  const post = (
    toolStatus: 'IN_PROGRESS' | 'FINISHED' | 'ERROR',
    message: string,
    workflowGeneration: string,
    callId = toolCallId
  ) =>
    request(`${BASE_URL}/api/agents/${agentId}/messages`, {
      method: 'POST',
      headers: {
        ...apiKeyHeaders(),
        'X-Agent-Workflow-Generation': workflowGeneration,
      },
      body: JSON.stringify({
        message,
        role: 'TOOL',
        metadata: {
          toolCallId: callId,
          toolName: 'web_search',
          toolStatus,
          workflowGeneration,
        },
      }),
    });

  const progress = await post('IN_PROGRESS', 'Searching', agentId);
  const earlySuccess = await post('FINISHED', 'Search result preview', agentId);
  const success = await post('FINISHED', 'Search complete', agentId);
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: replacementGeneration },
  });
  const staleProgress = await post('IN_PROGRESS', 'Still searching', agentId);
  const brandNewStaleCallId = `late-stale-${randomUUID()}`;
  const brandNewStale = await post(
    'IN_PROGRESS',
    'Started after cutover',
    agentId,
    brandNewStaleCallId
  );
  const replacementProgress = await post(
    'IN_PROGRESS',
    'Replacement searching',
    replacementGeneration
  );
  const replacementSuccess = await post('FINISHED', 'Replacement complete', replacementGeneration);

  assertStatus(progress.status, 201, progress.data);
  assertStatus(earlySuccess.status, 201, earlySuccess.data);
  assertStatus(success.status, 201, success.data);
  assertStatus(staleProgress.status, 201, staleProgress.data);
  assertStatus(brandNewStale.status, 201, brandNewStale.data);
  assertStatus(replacementProgress.status, 201, replacementProgress.data);
  assertStatus(replacementSuccess.status, 201, replacementSuccess.data);
  const successBody = assertSchema(PostMessageResponse, success.data, 'sticky TOOL success');
  const earlySuccessBody = assertSchema(
    PostMessageResponse,
    earlySuccess.data,
    'early TOOL success'
  );
  const staleProgressBody = assertSchema(
    PostMessageResponse,
    staleProgress.data,
    'sticky TOOL progress'
  );
  assert(
    earlySuccessBody.message_id !== successBody.message_id,
    'ordinary terminal updates must retain their existing multi-event behavior'
  );
  assert(
    staleProgressBody.message_id === successBody.message_id,
    'late stale progress must resolve to the fenced terminal result'
  );
  const brandNewStaleBody = assertSchema(
    PostMessageResponse,
    brandNewStale.data,
    'brand-new stale TOOL progress'
  );
  const replacementSuccessBody = assertSchema(
    PostMessageResponse,
    replacementSuccess.data,
    'replacement TOOL success'
  );
  assert(
    replacementSuccessBody.message_id !== successBody.message_id,
    'the replacement generation must be independent even when it reuses the call ID'
  );

  const terminalRows = await prisma.message.findMany({
    where: {
      agentId,
      role: 'TOOL',
      metadata: { path: ['toolCallId'], equals: toolCallId },
    },
  });
  const terminalStatuses = terminalRows
    .map((message) => (message.metadata as { toolStatus?: unknown } | null)?.toolStatus)
    .filter((status) => status === 'FINISHED' || status === 'ERROR');
  assert(
    JSON.stringify(terminalStatuses.sort()) ===
      JSON.stringify(['FINISHED', 'FINISHED', 'FINISHED']),
    `Expected old and replacement successes without a contradictory error, got ${JSON.stringify(terminalStatuses)}`
  );
  const brandNewStaleRow = await prisma.message.findUniqueOrThrow({
    where: { id: brandNewStaleBody.message_id },
  });
  assert(
    brandNewStaleRow.text === 'new code version deployed, retry this tool',
    'a first stale write after cutover must become the canonical deployment error'
  );
  assert(
    (brandNewStaleRow.metadata as { toolStatus?: unknown } | null)?.toolStatus === 'FINISHED',
    'brand-new stale progress must become a FINISHED error'
  );
  assert(
    (brandNewStaleRow.metadata as { error?: unknown } | null)?.error === true,
    'brand-new stale progress must be visible to the agent as an error'
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — changed TOOL metadata is a new event, exact retry is idempotent', async () => {
  const session = await createAnonymousSession('msg-spawn-tree-upgrade');
  const agentId = await createTestAgent(session.user.id, 'Spawn-tree upgrade test');
  const toolCallId = `spawn-tree-upgrade-${randomUUID().slice(0, 8)}`;
  const childAgentId = randomUUID();
  const base = {
    message: '',
    role: 'TOOL' as const,
    metadata: {
      toolCallId,
      toolName: 'spawn_general_purpose_agent',
      toolStatus: 'IN_PROGRESS',
      title: 'Spawning sub-agent',
    },
  };
  const upgradePayload = {
    ...base,
    metadata: { ...base.metadata, busId: agentId, subAgentIds: [childAgentId] },
  };

  const placeholder = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify(base),
  });
  const upgrade = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify(upgradePayload),
  });
  const retry = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify(upgradePayload),
  });

  assertStatus(placeholder.status, 201, placeholder.data);
  assertStatus(upgrade.status, 201, upgrade.data);
  assertStatus(retry.status, 201, retry.data);
  const placeholderBody = assertSchema(PostMessageResponse, placeholder.data, 'spawn placeholder');
  const upgradeBody = assertSchema(PostMessageResponse, upgrade.data, 'spawn upgrade');
  const retryBody = assertSchema(PostMessageResponse, retry.data, 'spawn upgrade retry');
  assert(
    upgradeBody.message_id !== placeholderBody.message_id,
    'same tool status/text/title with changed metadata must persist as a new event'
  );
  assert(
    retryBody.message_id === upgradeBody.message_id,
    'exact retry of the changed-metadata event must be idempotent'
  );

  const detail = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'spawn-tree upgrade detail');
  const withBusId = detailBody.messages.filter(
    (m) =>
      m.role === 'TOOL' &&
      typeof m.metadata === 'object' &&
      m.metadata !== null &&
      (m.metadata as Record<string, unknown>).toolCallId === toolCallId &&
      (m.metadata as Record<string, unknown>).busId !== undefined &&
      (m.metadata as Record<string, unknown>).busId !== null
  );
  const matchingToolCall = detailBody.messages.filter(
    (m) =>
      m.role === 'TOOL' &&
      typeof m.metadata === 'object' &&
      m.metadata !== null &&
      (m.metadata as Record<string, unknown>).toolCallId === toolCallId
  );
  assert(
    matchingToolCall.length === 2,
    `Expected placeholder plus changed-metadata TOOL event, got ${matchingToolCall.length}`
  );
  assert(
    withBusId.length === 1,
    `Expected exactly one persisted spawn-tree row with busId, got ${withBusId.length}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — read-after-write: message visible in detail', async () => {
  const session = await createAnonymousSession('msg-raw');
  const agentId = await createTestAgent(session.user.id, 'RAW message test');
  const msgText = `RAW test ${randomUUID().slice(0, 8)}`;

  await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: msgText, role: 'ASSISTANT' }),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'read-after-write messages');
  const found = body.messages.find((m) => m.text === msgText && m.role === 'ASSISTANT');
  assert(found, 'Posted message should be visible in agent detail');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — user role forced even if body says SYSTEM', async () => {
  const session = await createAnonymousSession('msg-role-force');
  const agentId = await createTestAgent(session.user.id, 'Role force test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'test', role: 'SYSTEM' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST messages role force');
  assert(body.role === 'USER', `JWT auth should force USER, got ${body.role}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= GET /:id/status =================================

test('GET /:id/status — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`);
  assertStatus(res.status, 401, res.data);
});

test('GET /:id/status — not found → 404', async () => {
  const session = await createAnonymousSession('status-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('GET /:id/status — happy path — schema validated', async () => {
  const session = await createAnonymousSession('status-happy');
  const agentId = await createTestAgent(session.user.id, 'Status test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(StatusResponse, res.data, 'GET /:id/status');
  assert(body.agent_id === agentId, 'Agent ID mismatch');
  assert(body.status === 'ACTIVE', `Expected ACTIVE, got ${body.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= PATCH /:id/status ===============================

test('PATCH /:id/status — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'ACTIVE',
      progress: 0.5,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });
  assertStatus(res.status, 401, res.data);
});

test('PATCH /:id/status — not found → 404', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'ACTIVE',
      progress: 0.5,
      tokenCount: 100,
      tokensIn: 50,
      tokensOut: 50,
      contextSize: 1000,
      messageCount: 5,
    }),
  });
  assertStatus(res.status, 404, res.data);
});

test('PATCH /:id/status — happy path — schema validated', async () => {
  const session = await createAnonymousSession('upd-status-happy');
  const agentId = await createTestAgent(session.user.id, 'Update status test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COMPLETED',
      statusMessage: 'All done',
      progress: 1.0,
      tokenCount: 5000,
      tokensIn: 3000,
      tokensOut: 2000,
      contextSize: 10000,
      messageCount: 20,
      iterationOffset: 17,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH /:id/status');
  assert(body.status === 'COMPLETED', `Expected COMPLETED, got ${body.status}`);
  assert(body.progress === 1.0, `Expected progress 1.0, got ${body.progress}`);
  assert(body.token_count === 5000, `Expected token_count 5000, got ${body.token_count}`);
  assert(body.status_message === 'All done', `Expected "All done", got "${body.status_message}"`);
  const stored = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { workflowIterationOffset: true },
  });
  assert(
    stored.workflowIterationOffset === 17,
    `Expected workflow iteration offset 17, got ${stored.workflowIterationOffset}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id/status — stale ACTIVE cannot overwrite terminal status', async () => {
  const session = await createAnonymousSession('upd-status-terminal-guard');
  const agentId = await createTestAgent(session.user.id, 'Terminal guard test');

  const completeRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COMPLETED',
      statusMessage: 'Done',
      progress: 1.0,
      tokenCount: 5000,
      tokensIn: 3000,
      tokensOut: 2000,
      contextSize: 10000,
      messageCount: 20,
    }),
  });
  assertStatus(completeRes.status, 200, completeRes.data);

  const staleRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'ACTIVE',
      statusMessage: 'Processing',
      progress: 0.16,
      tokenCount: 13089,
      tokensIn: 0,
      tokensOut: 2361,
      contextSize: 5942,
      messageCount: 12,
    }),
  });
  assertStatus(staleRes.status, 200, staleRes.data);
  const staleBody = assertSchema(UpdateStatusResponse, staleRes.data, 'stale status guard');
  assert(staleBody.status === 'COMPLETED', `Expected COMPLETED, got ${staleBody.status}`);
  assert(staleBody.progress === 1.0, `Expected progress 1.0, got ${staleBody.progress}`);
  assert(staleBody.status_message === 'Done', 'Expected terminal status message to persist');

  const detailRes = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detailRes.status, 200, detailRes.data);
  const detailBody = assertSchema(GetAgentResponse, detailRes.data, 'stale status detail');
  assert(
    detailBody.agent.status === 'COMPLETED',
    `Expected COMPLETED, got ${detailBody.agent.status}`
  );
  assert(
    detailBody.agent.progress === 1.0,
    `Expected progress 1.0, got ${detailBody.agent.progress}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id/status — invalid body → 400', async () => {
  const session = await createAnonymousSession('upd-status-bad');
  const agentId = await createTestAgent(session.user.id, 'Bad status body test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ status: 'INVALID_STATUS' }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id/status — read-after-write: status visible in detail', async () => {
  const session = await createAnonymousSession('upd-status-raw');

  // Create agent via HTTP so it's visible to the server
  const agentId = await createTestAgent(session.user.id, 'RAW status test');

  await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'FAILED',
      statusMessage: 'Something broke',
      progress: 0.3,
      tokenCount: 1000,
      contextSize: 5000,
      messageCount: 10,
    }),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'read-after-write status');
  assert(body.agent.status === 'FAILED', `Expected FAILED, got ${body.agent.status}`);
  assert(body.agent.status_message === 'Something broke', 'Status message mismatch');

  await deleteTestAgent(agentId, session.user.id);
});

// ================= POST /:id/workflow-replacement/bootstrap-ack ===========

test('POST bootstrap-ack — no auth → 401', async () => {
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/workflow-replacement/bootstrap-ack`,
    {
      method: 'POST',
      headers: { 'X-Agent-Workflow-Generation': `${FAKE_UUID}:candidate` },
    }
  );
  assertStatus(res.status, 401, res.data);
});

test('POST bootstrap-ack — user auth cannot consume internal recovery state → 403', async () => {
  const session = await createAnonymousSession('bootstrap-ack-user-auth');
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/workflow-replacement/bootstrap-ack`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(session.session.access_token),
        'X-Agent-Workflow-Generation': `${FAKE_UUID}:candidate`,
      },
    }
  );
  assertStatus(res.status, 403, res.data);
});

test('POST bootstrap-ack — internal auth requires workflow generation → 400', async () => {
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/workflow-replacement/bootstrap-ack`,
    {
      method: 'POST',
      headers: apiKeyHeaders(),
    }
  );
  assertStatus(res.status, 400, res.data);
});
