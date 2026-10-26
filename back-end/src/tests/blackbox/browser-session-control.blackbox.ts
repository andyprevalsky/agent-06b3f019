#!/usr/bin/env tsx
/** Black-box tenant isolation and ownership-handshake coverage for browser control. */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

interface JsonResponse {
  status: number;
  data: unknown;
}

async function request(url: string, options: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  return { status: response.status, data: await response.json() };
}

function expectStatus(result: JsonResponse, expected: number): void {
  if (result.status !== expected) {
    throw new Error(`Expected ${expected}, got ${result.status}: ${JSON.stringify(result.data)}`);
  }
}

function expectState(result: JsonResponse, expected: string): void {
  expectStatus(result, 200);
  if ((result.data as { state?: string }).state !== expected) {
    throw new Error(`Expected ${expected} ownership: ${JSON.stringify(result.data)}`);
  }
}

async function anonymousSession(): Promise<{ accessToken: string; userId: string }> {
  const result = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  expectStatus(result, 200);
  const data = result.data as { session: { access_token: string }; user: { id: string } };
  return { accessToken: data.session.access_token, userId: data.user.id };
}

async function testCrossUserResume(accessToken: string): Promise<void> {
  const context = await prisma.browserContext.create({
    data: { userId: `foreign-resume-${randomUUID()}`, contextId: `profile-${randomUUID()}` },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `foreign-session-${randomUUID()}`,
      status: 'PAUSED',
    },
  });
  try {
    const result = await request(`${BASE_URL}/api/browser-session/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ task_id: session.id }),
    });
    expectStatus(result, 404);
  } finally {
    await prisma.browserContext.delete({ where: { id: context.id } });
  }
}

async function testOwnershipHandshake(accessToken: string, userId: string): Promise<void> {
  const context = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId, contextId: `control-profile-${randomUUID()}` },
    update: {},
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `control-session-${randomUUID()}`,
      debugUrl: 'https://steel.example/replacement-live',
    },
  });
  const endpoint = `${BASE_URL}/api/browser-session/task/${session.id}/control`;
  const userHeaders = { Authorization: `Bearer ${accessToken}` };
  try {
    const taken = await request(endpoint, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ mode: 'user' }),
    });
    expectState(taken, 'user');
    if (
      (taken.data as { debugUrl?: string }).debugUrl !== 'https://steel.example/replacement-live'
    ) {
      throw new Error(`Control snapshot lost the live session URL: ${JSON.stringify(taken.data)}`);
    }
    const takenRow = await prisma.browserSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { status: true, controlState: true, controlLeaseExpiresAt: true, sessionId: true },
    });
    if (
      takenRow.status !== 'ACTIVE' ||
      takenRow.controlState !== 'USER' ||
      takenRow.controlLeaseExpiresAt === null
    ) {
      throw new Error(
        `Control handoff was not immediate same-session: ${JSON.stringify(takenRow)}`
      );
    }
    expectStatus(
      await request(endpoint, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ mode: 'acknowledge' }),
      }),
      403
    );
    expectState(
      await request(endpoint, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
        body: JSON.stringify({ mode: 'acknowledge' }),
      }),
      'user'
    );
    await prisma.browserSession.update({
      where: { id: session.id },
      data: { controlLeaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expectState(await request(endpoint, { headers: userHeaders }), 'agent');

    expectState(
      await request(endpoint, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ mode: 'user' }),
      }),
      'user'
    );
    expectState(
      await request(endpoint, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
        body: JSON.stringify({ mode: 'acknowledge' }),
      }),
      'user'
    );
    expectState(
      await request(endpoint, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ mode: 'agent' }),
      }),
      'agent'
    );
  } finally {
    await prisma.browserSession.delete({ where: { id: session.id } });
  }
}

/** The live view's binding read: owner-only, closed rows report live=false. */
async function testLiveViewBinding(accessToken: string, userId: string): Promise<void> {
  const context = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId, contextId: `live-view-profile-${randomUUID()}` },
    update: {},
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `live-view-session-${randomUUID()}`,
      debugUrl: 'https://connect.steel.dev/v1/sessions/released/player?interactive=false',
      status: 'CLOSED',
    },
  });
  const foreignContext = await prisma.browserContext.create({
    data: { userId: `foreign-live-view-${randomUUID()}`, contextId: `profile-${randomUUID()}` },
  });
  const foreign = await prisma.browserSession.create({
    data: {
      contextId: foreignContext.id,
      agentId: randomUUID(),
      sessionId: `foreign-live-view-${randomUUID()}`,
      status: 'ACTIVE',
    },
  });
  const liveView = (taskId: string) => `${BASE_URL}/api/browser-session/task/${taskId}/live-view`;
  const userHeaders = { Authorization: `Bearer ${accessToken}` };
  try {
    expectStatus(await request(liveView(session.id)), 401);
    expectStatus(await request(liveView(foreign.id), { headers: userHeaders }), 404);
    const before = Date.now();
    const owned = await request(liveView(session.id), { headers: userHeaders });
    expectStatus(owned, 200);
    const view = owned.data as Record<string, unknown>;
    if (
      view.taskId !== session.id ||
      view.sessionId !== session.sessionId ||
      view.debugUrl !== session.debugUrl ||
      view.status !== 'CLOSED' ||
      view.live !== false ||
      typeof view.asOf !== 'number' ||
      view.asOf < before - 60_000
    ) {
      throw new Error(`Unexpected live-view binding: ${JSON.stringify(view)}`);
    }
    const leaseRow = await prisma.browserSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { controlState: true },
    });
    if (leaseRow.controlState !== 'AGENT') throw new Error('live-view read mutated control state');
  } finally {
    await prisma.browserSession.delete({ where: { id: session.id } });
    await prisma.browserContext.delete({ where: { id: foreignContext.id } });
  }
}

/**
 * Browser composer: a user message addressed to one ACTIVE browser task goes to
 * that browser only. The owner probe is a finished run that still records a
 * workflow id: any owner delivery (workflow signal or chat handler) first
 * clears that id and reopens the agent, so it is observable without Temporal.
 * Its model is rose-local, so a reopened chat turn makes no remote LLM call.
 * A paused/ended browser session would never read the message, so it falls
 * back to normal owner delivery.
 */
async function testBrowserTargetedMessage(accessToken: string, userId: string): Promise<void> {
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Browser composer target',
      status: 'COMPLETED',
      model: 'rose-labs/rose-local',
      temporalWorkflowId: `composer-probe-${randomUUID()}`,
    },
  });
  const context = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId, contextId: `composer-profile-${randomUUID()}` },
    update: {},
  });
  const session = (agentId: string, status: 'ACTIVE' | 'PAUSED') =>
    prisma.browserSession.create({
      data: { contextId: context.id, agentId, sessionId: `composer-${randomUUID()}`, status },
    });
  const live = await session(agent.id, 'ACTIVE');
  const pausedRun = await session(agent.id, 'PAUSED');
  const foreign = await session(randomUUID(), 'ACTIVE');
  const post = (browserTaskId: string, extra: Record<string, unknown> = {}) =>
    request(`${BASE_URL}/api/agents/${agent.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        message: 'go to instacart instead',
        browser_task_id: browserTaskId,
        ...extra,
      }),
    });
  const stored = async (sent: JsonResponse) =>
    prisma.message.findUniqueOrThrow({
      where: { id: (sent.data as { message_id: string }).message_id },
      select: { role: true, text: true, metadata: true },
    });
  const owner = () =>
    prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { status: true, statusMessage: true, temporalWorkflowId: true },
    });
  try {
    const before = await owner();
    const sent = await post(live.id);
    expectStatus(sent, 201);
    const row = await stored(sent);
    const metadata = row.metadata as Record<string, unknown>;
    if (
      row.role !== 'USER' ||
      row.text !== 'go to instacart instead' ||
      metadata.browserTaskId !== live.id ||
      metadata.excludeFromModel !== true
    ) {
      throw new Error(`Browser-targeted message was not tagged: ${JSON.stringify(row)}`);
    }
    // Neither signalled nor chat-handled: the owner row is untouched.
    if (JSON.stringify(await owner()) !== JSON.stringify(before)) {
      throw new Error(
        `Browser-targeted message reached the owner: ${JSON.stringify(await owner())}`
      );
    }
    expectStatus(await post(randomUUID()), 404);
    expectStatus(await post(foreign.id), 404);
    const file = {
      id: randomUUID(),
      storage_path: 'composer/notes.txt',
      original_filename: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: 5,
      created_at: new Date().toISOString(),
    };
    expectStatus(await post(live.id, { attachments: [file] }), 400);
    expectStatus(await post(live.id, { file_pointer: file }), 400);
    if ((await prisma.message.count({ where: { agentId: agent.id } })) !== 1) {
      throw new Error('Rejected browser targets stored messages');
    }
    // Run ended / pause-closed browser: delivered to the owner as before, never lost.
    const fallback = await post(pausedRun.id);
    expectStatus(fallback, 201);
    const fallbackMetadata = ((await stored(fallback)).metadata ?? {}) as Record<string, unknown>;
    if ('browserTaskId' in fallbackMetadata || 'excludeFromModel' in fallbackMetadata) {
      throw new Error(`Paused-browser message was hidden: ${JSON.stringify(fallbackMetadata)}`);
    }
    const after = await owner();
    if (after.temporalWorkflowId !== null) {
      throw new Error(`Paused-browser message did not reach the owner: ${JSON.stringify(after)}`);
    }
  } finally {
    await prisma.browserSession.deleteMany({
      where: { id: { in: [live.id, pausedRun.id, foreign.id] } },
    });
    // The reopened chat turn may still be writing its (local-model) failure row.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await prisma.message.deleteMany({ where: { agentId: agent.id } });
    await prisma.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
  }
}

async function runAll(): Promise<void> {
  const { accessToken, userId } = await anonymousSession();
  await testCrossUserResume(accessToken);
  await testOwnershipHandshake(accessToken, userId);
  await testLiveViewBinding(accessToken, userId);
  await testBrowserTargetedMessage(accessToken, userId);
  await prisma.$disconnect();
  console.log('PASS browser-session-control (4 cases)');
}

runAll().catch(async (error) => {
  console.error('FAIL browser-session-control', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
