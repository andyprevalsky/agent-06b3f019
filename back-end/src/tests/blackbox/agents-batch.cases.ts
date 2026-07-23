import { strict as nodeAssert } from 'node:assert';
import {
  BASE_URL,
  FAKE_UUID,
  RUN_ID,
  trackedAgentIds,
  ErrorResponse,
  authHeaders,
  apiKeyHeaders,
  request,
  assertStatus,
  assertSchema,
  assert,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  prepareTestParentWorkflow,
  test,
  prisma,
  randomUUID,
  z,
} from './agents-blackbox-harness';

// ---------------------------------------------------------------------------
// POST /agents/batch — bulk create endpoint
// ---------------------------------------------------------------------------

const BatchAgentResultSchema = z.object({
  agent_id: z.string().uuid(),
  status: z.enum(['STARTING_UP', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED']),
  temporal_workflow_id: z.string().nullable(),
  goal: z.string().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  already_existed: z.boolean().optional(),
});
const BatchResponseSchema = z.object({ results: z.array(BatchAgentResultSchema) });

function makeBatchAgent(opts: {
  parentAgentId: string;
  busId: string;
  goal?: string;
  attachments?: unknown[];
}) {
  return {
    agent_id: randomUUID(),
    goal: opts.goal ?? `Batch child ${RUN_ID} ${randomUUID().slice(0, 8)}`,
    model: 'rose-labs/rose-1-lite',
    parent_agent_id: opts.parentAgentId,
    parent_workflow_id: opts.parentAgentId,
    bus_id: opts.busId,
    depth: 1,
    start_phase: 'execute',
    max_iterations: 25,
    context_gates: { network: false },
    response_schema: { fields: [{ name: 'value', type: 'int', required: true, description: 'x' }] },
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
  };
}

test('POST /agents/batch — happy path: 3 children all spawn', async () => {
  const session = await createAnonymousSession('batch-happy');
  const parentId = await createTestAgent(session.user.id, 'Batch parent');
  await prepareTestParentWorkflow(parentId);
  const agents = [1, 2, 3].map(() => makeBatchAgent({ parentAgentId: parentId, busId: parentId }));
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  // Expected status: 201 if all phase-2 starts succeed, 207 if any failed.
  // Either is valid for an integration test against a real Temporal cluster;
  // assert the per-child result shape rather than the aggregate code.
  assert(
    res.status === 201 || res.status === 207,
    `Expected 201 or 207, got ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`
  );
  const body = assertSchema(BatchResponseSchema, res.data, 'batch happy path');
  assert(body.results.length === 3, `Expected 3 results, got ${body.results.length}`);
  for (const r of body.results) {
    assert(r.status === 'STARTING_UP' || r.status === 'FAILED', `Unexpected status ${r.status}`);
    if (r.status === 'STARTING_UP') {
      assert(r.temporal_workflow_id === r.agent_id, 'workflow_id should equal agent_id');
    }
    trackedAgentIds.add(r.agent_id);
  }
  const stored = await prisma.agent.findMany({
    where: { id: { in: body.results.map((result) => result.agent_id) } },
    select: { workflowMaxIterations: true, workflowContextGates: true },
  });
  assert(
    stored.every((row) => row.workflowMaxIterations === 25),
    'batch max_iterations not persisted'
  );
  assert(
    stored.every((row) => JSON.stringify(row.workflowContextGates) === '{"network":false}'),
    'batch context_gates not persisted'
  );
  for (const r of body.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — anonymous JWT cannot create children → 401', async () => {
  const session = await createAnonymousSession('batch-anon-rejected');
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({
      agents: [
        makeBatchAgent({
          parentAgentId: FAKE_UUID,
          busId: FAKE_UUID,
          goal: 'Anonymous batch create should fail',
        }),
      ],
    }),
  });
  assertStatus(res.status, 401, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'POST /agents/batch anonymous rejected');
  assert(body.error.includes('Login required'), `Unexpected error: ${body.error}`);
});

test('POST /agents/batch — missing agents → 400', async () => {
  const session = await createAnonymousSession('batch-empty');
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents: [] }),
  });
  assertStatus(res.status, 400, res.data);
});

test('POST /agents/batch — > 200 children → 400', async () => {
  const session = await createAnonymousSession('batch-too-big');
  const parentId = await createTestAgent(session.user.id, 'Batch too big');
  await prepareTestParentWorkflow(parentId);
  const agents = Array.from({ length: 201 }, () =>
    makeBatchAgent({ parentAgentId: parentId, busId: parentId })
  );
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assertStatus(res.status, 400, res.data);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — child missing goal rolls back the entire batch', async () => {
  // Phase-1 atomic guarantee: if any single child fails Zod validation, NO
  // rows are created. We assert this by counting agents owned by this user
  // before and after a partially-bad batch.
  const session = await createAnonymousSession('batch-rollback');
  const parentId = await createTestAgent(session.user.id, 'Batch rollback parent');
  await prepareTestParentWorkflow(parentId);
  const beforeCount = await prisma.agent.count({ where: { userId: session.user.id } });
  const agents = [
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
    // missing goal — Zod rejects
    {
      agent_id: randomUUID(),
      model: 'rose-labs/rose-1-lite',
      parent_agent_id: parentId,
      parent_workflow_id: parentId,
      bus_id: parentId,
      depth: 1,
    },
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
  ];
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assertStatus(res.status, 400, res.data);
  const afterCount = await prisma.agent.count({ where: { userId: session.user.id } });
  assert(
    afterCount === beforeCount,
    `Expected no rows added; before=${beforeCount} after=${afterCount}`
  );
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — idempotent on retry with same agent_ids', async () => {
  // Worker mints stable child agent_ids upfront so a re-POST after a
  // partial-success returns the existing rows untouched (already_existed=true)
  // and does NOT create duplicates.
  const session = await createAnonymousSession('batch-idempotent');
  const parentId = await createTestAgent(session.user.id, 'Batch idempotent parent');
  await prepareTestParentWorkflow(parentId);
  const agents = [
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
  ];
  const first = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(
    first.status === 201 || first.status === 207,
    `First POST: expected 201 or 207, got ${first.status}`
  );
  const firstBody = assertSchema(BatchResponseSchema, first.data, 'idempotent first');
  for (const r of firstBody.results) trackedAgentIds.add(r.agent_id);
  // Re-POST identical body — same agent_ids.
  const second = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(
    second.status === 201 || second.status === 207,
    `Second POST: expected 201 or 207, got ${second.status}`
  );
  const secondBody = assertSchema(BatchResponseSchema, second.data, 'idempotent second');
  // Every result on the retry should be flagged as pre-existing.
  for (const r of secondBody.results) {
    assert(r.already_existed === true, `Expected already_existed=true on retry for ${r.agent_id}`);
  }
  // DB should still have exactly the original 2 children + parent.
  const childCount = await prisma.agent.count({
    where: { userId: session.user.id, parentAgentId: parentId, deletedAt: null },
  });
  assert(childCount === 2, `Expected 2 children after retry, got ${childCount}`);
  for (const r of firstBody.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents — lost 201 retry resumes the same durable child', async () => {
  const session = await createAnonymousSession('single-child-lost-201');
  const parentId = await createTestAgent(session.user.id, 'Single retry parent');
  await prepareTestParentWorkflow(parentId);
  const child = makeBatchAgent({ parentAgentId: parentId, busId: parentId });
  const first = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify(child),
  });
  assertStatus(first.status, 201, first.data);
  trackedAgentIds.add(child.agent_id);

  // Discard the first response exactly as a dropped connection would, then
  // retry the immutable request with the worker-minted ID.
  const retry = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify(child),
  });
  assertStatus(retry.status, 201, retry.data);
  const retried = retry.data as { agent_id: string; temporal_workflow_id: string };
  nodeAssert.strictEqual(retried.agent_id, child.agent_id);
  nodeAssert.strictEqual(retried.temporal_workflow_id, child.agent_id);
  nodeAssert.strictEqual(await prisma.agent.count({ where: { id: child.agent_id } }), 1);

  await deleteTestAgent(child.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — changed payload colliding with stable ID is rejected', async () => {
  const session = await createAnonymousSession('batch-payload-collision');
  const parentId = await createTestAgent(session.user.id, 'Batch collision parent');
  await prepareTestParentWorkflow(parentId);
  const child = makeBatchAgent({ parentAgentId: parentId, busId: parentId });
  const first = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents: [child] }),
  });
  assert(first.status === 201 || first.status === 207, `Unexpected first status ${first.status}`);
  trackedAgentIds.add(child.agent_id);

  const changed = { ...child, goal: `${child.goal} changed after retry` };
  const collision = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents: [changed] }),
  });
  assertStatus(collision.status, 409, collision.data);
  nodeAssert.match(
    String((collision.data as { error?: string }).error),
    /changed immutable field goal/
  );
  nodeAssert.strictEqual(
    (await prisma.agent.findUniqueOrThrow({ where: { id: child.agent_id } })).goal,
    child.goal
  );

  await deleteTestAgent(child.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — mixed pending, settled, and new rows reconcile once', async () => {
  const session = await createAnonymousSession('batch-mixed-retry');
  const parentId = await createTestAgent(session.user.id, 'Batch mixed retry parent');
  await prepareTestParentWorkflow(parentId);
  const pending = makeBatchAgent({ parentAgentId: parentId, busId: parentId });
  const settled = makeBatchAgent({ parentAgentId: parentId, busId: parentId });
  const first = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents: [pending, settled] }),
  });
  assertStatus(first.status, 201, first.data);
  trackedAgentIds.add(pending.agent_id);
  trackedAgentIds.add(settled.agent_id);
  await prisma.agent.update({
    where: { id: pending.agent_id },
    data: {
      status: 'STARTING_UP',
      temporalWorkflowId: pending.agent_id,
      temporalFirstExecutionRunId: null,
      temporalWorkflowStartPending: true,
      temporalWorkflowStartLeaseUntil: null,
    },
  });
  const fresh = makeBatchAgent({ parentAgentId: parentId, busId: parentId });
  trackedAgentIds.add(fresh.agent_id);

  const retry = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents: [pending, settled, fresh] }),
  });
  assertStatus(retry.status, 201, retry.data);
  const retried = assertSchema(BatchResponseSchema, retry.data, 'mixed batch retry');
  const byId = new Map(retried.results.map((result) => [result.agent_id, result]));
  nodeAssert.strictEqual(byId.get(settled.agent_id)?.already_existed, true);
  nodeAssert.strictEqual(byId.get(pending.agent_id)?.temporal_workflow_id, pending.agent_id);
  nodeAssert.strictEqual(byId.get(fresh.agent_id)?.temporal_workflow_id, fresh.agent_id);
  nodeAssert.strictEqual(
    (await prisma.agent.findUniqueOrThrow({ where: { id: pending.agent_id } }))
      .temporalWorkflowStartPending,
    false
  );
  nodeAssert.strictEqual(
    await prisma.agent.count({
      where: { id: { in: [pending.agent_id, settled.agent_id, fresh.agent_id] } },
    }),
    3
  );

  for (const child of [pending, settled, fresh]) {
    await deleteTestAgent(child.agent_id, session.user.id);
  }
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — sub-agents inherit parent proxyCountry', async () => {
  // Fix #2 from the latency optimization PR: sub-agents must inherit their
  // parent's proxyCountry/State/City rather than being geolocated from the
  // worker IP. The batch endpoint must honor the same rule.
  const session = await createAnonymousSession('batch-proxy-inherit');
  const parentId = await createTestAgent(session.user.id, 'Batch proxy parent');
  await prepareTestParentWorkflow(parentId);
  // Stamp a known proxy on the parent so we can assert children copy it.
  await prisma.agent.update({
    where: { id: parentId },
    data: { proxyCountry: 'XB', proxyState: 'TX', proxyCity: 'TESTCITY' },
  });
  const agents = [
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
  ];
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(res.status === 201 || res.status === 207, `Expected 201 or 207, got ${res.status}`);
  const body = assertSchema(BatchResponseSchema, res.data, 'batch proxy inherit');
  for (const r of body.results) trackedAgentIds.add(r.agent_id);
  const children = await prisma.agent.findMany({
    where: { id: { in: body.results.map((r) => r.agent_id) } },
    select: { id: true, proxyCountry: true, proxyState: true, proxyCity: true },
  });
  assert(children.length === 2, `Expected 2 children rows`);
  for (const c of children) {
    assert(c.proxyCountry === 'XB', `Child ${c.id} proxyCountry=${c.proxyCountry}, expected XB`);
    assert(c.proxyState === 'TX', `Child ${c.id} proxyState=${c.proxyState}, expected TX`);
    assert(c.proxyCity === 'TESTCITY', `Child ${c.id} proxyCity=${c.proxyCity}, expected TESTCITY`);
  }
  for (const r of body.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — temporalWorkflowId set up-front (no UPDATE needed)', async () => {
  // Fix #3 from the latency optimization PR: temporal_workflow_id === agent_id
  // and is written during the create transaction, never via a follow-up UPDATE.
  const session = await createAnonymousSession('batch-twfid-up-front');
  const parentId = await createTestAgent(session.user.id, 'Batch twfid parent');
  await prepareTestParentWorkflow(parentId);
  const agents = [makeBatchAgent({ parentAgentId: parentId, busId: parentId })];
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(res.status === 201 || res.status === 207, `Expected 201 or 207, got ${res.status}`);
  const body = assertSchema(BatchResponseSchema, res.data, 'twfid up-front');
  for (const r of body.results) trackedAgentIds.add(r.agent_id);
  const child = body.results[0];
  if (child.status === 'STARTING_UP') {
    const row = await prisma.agent.findUnique({
      where: { id: child.agent_id },
      select: { temporalWorkflowId: true, id: true },
    });
    assert(row?.temporalWorkflowId === row?.id, 'temporalWorkflowId must equal agent.id');
  }
  for (const r of body.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});
