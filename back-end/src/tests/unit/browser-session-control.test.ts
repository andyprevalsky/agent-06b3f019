/**
 * RCA: take-control of a live ACTIVE browser must grant USER immediately
 * on the same session (same debugUrl / sessionId). The two-phase
 * USER_REQUESTED handshake stalled the second browser in prod agent
 * 3b2a912a because the activity only acknowledges at an action boundary.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { transitionBrowserControlState } from '../../domains/browser-session/repo';
import {
  BrowserControlUnavailableError,
  setBrowserControlState,
} from '../../domains/browser-session/service.control';

const LIVE_URL = 'https://connect.steel.dev/v1/sessions/second-browser/player?interactive=false';

async function withOwnedSession<T>(
  fn: (input: { taskId: string; sessionId: string; userId: string }) => Promise<T>
): Promise<T> {
  const userId = `control-user-${randomUUID()}`;
  const context = await prisma.browserContext.create({
    data: { userId, contextId: `control-profile-${randomUUID()}` },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `live-session-${randomUUID()}`,
      debugUrl: LIVE_URL,
      status: 'ACTIVE',
      controlState: 'AGENT',
    },
  });
  try {
    return await fn({ taskId: session.id, sessionId: session.sessionId, userId });
  } finally {
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
  }
}

async function testActiveTakeControlIsImmediateSameSession(): Promise<void> {
  await withOwnedSession(async ({ taskId, sessionId, userId }) => {
    const snapshot = await setBrowserControlState(taskId, 'user', userId);
    assert.equal(
      snapshot.state,
      'user',
      `ACTIVE take-control must grant user immediately, got ${JSON.stringify(snapshot)}`
    );
    assert.equal(snapshot.debugUrl, LIVE_URL, 'handover must reuse the exact live debug URL');

    const row = await prisma.browserSession.findUniqueOrThrow({
      where: { id: taskId },
      select: { sessionId: true, debugUrl: true, status: true, controlState: true },
    });
    assert.equal(row.sessionId, sessionId, 'handover must not mint a replacement provider session');
    assert.equal(row.debugUrl, LIVE_URL);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.controlState, 'USER');
  });
}

async function testLeftoverRequestedBecomesUserOnSameSession(): Promise<void> {
  await withOwnedSession(async ({ taskId, sessionId, userId }) => {
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { controlState: 'USER_REQUESTED' },
    });
    const snapshot = await setBrowserControlState(taskId, 'user', userId);
    assert.equal(snapshot.state, 'user', 'leftover requested must grant user immediately');
    assert.equal(snapshot.debugUrl, LIVE_URL);

    const row = await prisma.browserSession.findUniqueOrThrow({
      where: { id: taskId },
      select: { sessionId: true, debugUrl: true, controlState: true },
    });
    assert.equal(row.sessionId, sessionId);
    assert.equal(row.debugUrl, LIVE_URL);
    assert.equal(row.controlState, 'USER');
  });
}

async function testClosedRequestedDoesNotGrantUser(): Promise<void> {
  await withOwnedSession(async ({ taskId, userId }) => {
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { status: 'CLOSED', controlState: 'USER_REQUESTED' },
    });
    await assert.rejects(
      () => setBrowserControlState(taskId, 'user', userId),
      BrowserControlUnavailableError
    );
    const row = await prisma.browserSession.findUniqueOrThrow({
      where: { id: taskId },
      select: { controlState: true, status: true },
    });
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.controlState, 'USER_REQUESTED');
  });
}

async function testClosedRequestedTransitionIsRejectedByStatusFilter(): Promise<void> {
  await withOwnedSession(async ({ taskId }) => {
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { status: 'CLOSED', controlState: 'USER_REQUESTED' },
    });
    const updated = await transitionBrowserControlState(
      taskId,
      ['USER_REQUESTED'],
      'USER',
      new Date(Date.now() + 90_000)
    );
    assert.equal(updated, false, 'CLOSED USER_REQUESTED CAS must fail when status is not ACTIVE');
    const row = await prisma.browserSession.findUniqueOrThrow({
      where: { id: taskId },
      select: { controlState: true, status: true },
    });
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.controlState, 'USER_REQUESTED');
  });
}

async function testSecondBrowserHandoffDoesNotTouchTheFirst(): Promise<void> {
  const userId = `control-user-${randomUUID()}`;
  const context = await prisma.browserContext.create({
    data: { userId, contextId: `control-profile-${randomUUID()}` },
  });
  const first = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `first-${randomUUID()}`,
      debugUrl: 'https://connect.steel.dev/v1/sessions/first/player?interactive=false',
      status: 'ACTIVE',
      controlState: 'AGENT',
    },
  });
  const second = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `second-${randomUUID()}`,
      debugUrl: LIVE_URL,
      status: 'ACTIVE',
      controlState: 'AGENT',
    },
  });
  try {
    const snapshot = await setBrowserControlState(second.id, 'user', userId);
    assert.equal(snapshot.state, 'user');
    assert.equal(snapshot.debugUrl, LIVE_URL);

    const firstRow = await prisma.browserSession.findUniqueOrThrow({
      where: { id: first.id },
      select: { controlState: true, sessionId: true, debugUrl: true },
    });
    assert.equal(firstRow.controlState, 'AGENT');
    assert.equal(firstRow.sessionId, first.sessionId);
    assert.equal(
      firstRow.debugUrl,
      'https://connect.steel.dev/v1/sessions/first/player?interactive=false'
    );
  } finally {
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
  }
}

async function runAll(): Promise<void> {
  await testActiveTakeControlIsImmediateSameSession();
  await testLeftoverRequestedBecomesUserOnSameSession();
  await testClosedRequestedDoesNotGrantUser();
  await testClosedRequestedTransitionIsRejectedByStatusFilter();
  await testSecondBrowserHandoffDoesNotTouchTheFirst();
  await prisma.$disconnect();
  process.stdout.write('PASS browser-session-control unit (5 cases)\n');
}

runAll().catch(async (error) => {
  process.stderr.write(`FAIL browser-session-control unit ${String(error)}\n`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
