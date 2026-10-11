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

async function runAll(): Promise<void> {
  const { accessToken, userId } = await anonymousSession();
  await testCrossUserResume(accessToken);
  await testOwnershipHandshake(accessToken, userId);
  await testLiveViewBinding(accessToken, userId);
  await prisma.$disconnect();
  console.log('PASS browser-session-control (3 cases)');
}

runAll().catch(async (error) => {
  console.error('FAIL browser-session-control', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
