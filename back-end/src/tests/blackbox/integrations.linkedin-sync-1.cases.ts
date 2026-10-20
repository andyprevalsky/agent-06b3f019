/**
 * LinkedIn export sync state: POST /api/integrations/linkedin/sync records the
 * spawned export agent, and GET /api/integrations reports the `linkedin` row
 * SYNCING while that agent can still upload — so "Connecting" survives a page
 * refresh — then SYNC_FAILED once it ends without uploading.
 */
import { randomUUID } from 'node:crypto';
import {
  prisma,
  createAnonSession,
  request,
  authHeaders,
  assertStatus,
  assert,
  BASE_URL,
} from './integrations.context';

const SYNC_URL = `${BASE_URL}/api/integrations/linkedin/sync`;

type ListedIntegration = { name: string; status: string; config?: { syncAgentId?: string } };

async function createAgentFor(
  userId: string,
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED',
  extra: { temporalWorkflowId?: string; createdAt?: Date } = {}
) {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId,
      goal: 'Download my LinkedIn data export and upload it to the platform.',
      status,
      model: 'rose-labs/rose-1-ultra',
      busId: id,
      ...extra,
    },
  });
  return id;
}

async function startSync(accessToken: string, agentId: string) {
  return request(SYNC_URL, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ agent_id: agentId }),
  });
}

async function linkedinRow(accessToken: string): Promise<ListedIntegration | undefined> {
  const res = await request(`${BASE_URL}/api/integrations`, { headers: authHeaders(accessToken) });
  assertStatus(res.status, 200, res.data);
  const { integrations } = res.data as { integrations: ListedIntegration[] };
  return integrations.find((i) => i.name === 'linkedin');
}

export async function testLinkedinSync_noAuth() {
  const res = await request(SYNC_URL, {
    method: 'POST',
    body: JSON.stringify({ agent_id: randomUUID() }),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testLinkedinSync_missingAgentId() {
  const { accessToken } = await createAnonSession();
  const res = await request(SYNC_URL, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assert(typeof (res.data as { error?: unknown }).error === 'string', 'error must be a string');
}

export async function testLinkedinSync_rejectsAnotherUsersAgent() {
  const owner = await createAnonSession();
  const other = await createAnonSession();
  const agentId = await createAgentFor(owner.userId, 'ACTIVE');
  try {
    const res = await request(SYNC_URL, {
      method: 'POST',
      headers: authHeaders(other.accessToken),
      body: JSON.stringify({ agent_id: agentId }),
    });
    assertStatus(res.status, 404, res.data);
    assert((await linkedinRow(other.accessToken)) === undefined, 'no row for the other user');
  } finally {
    await prisma.agent.delete({ where: { id: agentId } });
  }
}

export async function testLinkedinSync_runningAgentReadsSyncingThenSettles() {
  const { accessToken, userId } = await createAnonSession();
  const agentId = await createAgentFor(userId, 'ACTIVE');
  try {
    const res = await request(SYNC_URL, {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({ agent_id: agentId }),
    });
    assertStatus(res.status, 200, res.data);
    assert((res.data as { status?: string }).status === 'SYNCING', 'sync starts SYNCING');

    // A fresh read (what a page refresh does) still reports the running sync.
    const running = await linkedinRow(accessToken);
    assert(running?.status === 'SYNCING', `expected SYNCING, got ${running?.status}`);
    assert(running.config?.syncAgentId === agentId, 'row remembers its export agent');

    // The agent ends without uploading: the row stops reading as Connecting.
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    const settled = await linkedinRow(accessToken);
    assert(settled?.status === 'SYNC_FAILED', `expected SYNC_FAILED, got ${settled?.status}`);

    // An archived export agent settles the same way.
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: 'ACTIVE', deletedAt: new Date() },
    });
    const archived = await linkedinRow(accessToken);
    assert(archived?.status === 'SYNC_FAILED', `expected SYNC_FAILED, got ${archived?.status}`);
  } finally {
    await prisma.agent.delete({ where: { id: agentId } });
  }
}

export async function testLinkedinSync_chatAgentThatNeverStartedSettles() {
  // Incident 1df3cbe4: the chat router failed, so the agent stayed ACTIVE with
  // no workflow forever. Once the start grace is over it must not read as
  // "Connecting" — the user has to be able to retry.
  const { accessToken, userId } = await createAnonSession();
  const agentId = await createAgentFor(userId, 'ACTIVE', {
    createdAt: new Date(Date.now() - 3 * 60_000),
  });
  try {
    const res = await startSync(accessToken, agentId);
    assertStatus(res.status, 200, res.data);
    const row = await linkedinRow(accessToken);
    assert(row?.status === 'SYNC_FAILED', `expected SYNC_FAILED, got ${row?.status}`);
  } finally {
    await prisma.agent.delete({ where: { id: agentId } });
  }
}

export async function testLinkedinSync_runningWorkflowStaysSyncingAndBlocksDuplicate() {
  const { accessToken, userId } = await createAnonSession();
  const running = await createAgentFor(userId, 'ACTIVE', {
    temporalWorkflowId: `wf-${randomUUID()}`,
    createdAt: new Date(Date.now() - 30 * 60_000),
  });
  const duplicate = await createAgentFor(userId, 'ACTIVE');
  try {
    assertStatus((await startSync(accessToken, running)).status, 200, null);
    const row = await linkedinRow(accessToken);
    assert(row?.status === 'SYNCING', `long-running export must stay SYNCING, got ${row?.status}`);

    const res = await startSync(accessToken, duplicate);
    assertStatus(res.status, 409, res.data);
    assert((res.data as { agent_id?: string }).agent_id === running, '409 names the running agent');
    assert((await linkedinRow(accessToken))?.config?.syncAgentId === running, 'row unchanged');
  } finally {
    await prisma.agent.deleteMany({ where: { id: { in: [running, duplicate] } } });
  }
}
