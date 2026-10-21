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
  getBrowserLiveView,
  setBrowserControlState,
} from '../../domains/browser-session/service.control';
import { SessionNotFoundError } from '../../domains/browser-session/service.local-storage';
import type { BrowserSessionHealth } from '../../providers/browser/types';
import { TilionApiError } from '../../providers/browser/tilion';

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

async function testClosedUserDoesNotReportUser(): Promise<void> {
  await withOwnedSession(async ({ taskId, userId }) => {
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { status: 'CLOSED', controlState: 'USER' },
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

type LiveViewRecord = NonNullable<
  Awaited<ReturnType<typeof import('../../domains/browser-session/repo').findBrowserLiveViewRecord>>
>;

function liveViewRecord(
  status: LiveViewRecord['status'],
  userId = 'owner',
  provider = 'steel'
): LiveViewRecord {
  return {
    id: 'task-live-view',
    sessionId: 'f26ee1ab-f769-42d7-90a0-5d014fc1284f',
    status,
    debugUrl: LIVE_URL,
    provider,
    context: { userId },
  };
}

function health(status: string | null, ttlMs: number | null): BrowserSessionHealth {
  return {
    provider: 'steel',
    sessionId: 'f26ee1ab-f769-42d7-90a0-5d014fc1284f',
    status,
    createdAt: null,
    timeoutMs: null,
    expiresAt: null,
    ttlMs,
    profileId: null,
  } as BrowserSessionHealth;
}

/** Agent 8b4d4592: the auth handoff row stayed ACTIVE ~26h after Steel ended the session. */
async function testLiveViewReportsProviderEndedSessionAsNotLive(): Promise<void> {
  const before = Date.now();
  const view = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE'),
    health: async () => health('released', 0),
  });
  assert.equal(view.live, false);
  assert.equal(view.debugUrl, LIVE_URL);
  assert.equal(view.status, 'ACTIVE');
  assert.ok(view.asOf >= before && view.asOf <= Date.now(), 'asOf is the server read time');

  const running = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE'),
    health: async () => health('live', 600_000),
  });
  assert.equal(running.live, true);
}

async function testLiveViewClosedRowSkipsProviderAndUnknownHealthIsNull(): Promise<void> {
  let healthCalls = 0;
  const closed = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('CLOSED'),
    health: async () => {
      healthCalls += 1;
      return health('live', 1);
    },
  });
  assert.equal(closed.live, false);
  assert.equal(healthCalls, 0, 'a closed row needs no provider call');

  const unknown = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE'),
    health: async () => {
      throw new Error('provider unavailable');
    },
  });
  assert.equal(unknown.live, null, 'unknown provider health is not reported as dead');
}

async function testLiveViewHidesAnotherUsersTask(): Promise<void> {
  await assert.rejects(
    getBrowserLiveView('task-live-view', 'intruder', {
      findRecord: async () => liveViewRecord('ACTIVE', 'owner'),
      health: async () => health('live', 1),
    }),
    SessionNotFoundError
  );
}

/** Tilion view tokens last 1800 s: every live read mints a fresh URL; ended sessions mint nothing. */
async function testTilionLiveViewMintsFreshUrlAndEndedIsNotLive(): Promise<void> {
  let mints = 0;
  const mintTilionLiveViewUrl = async (sessionId: string) => {
    mints += 1;
    return `https://back.tilion.dev/v1/session/${sessionId}/live-view?token=t${mints}`;
  };
  const first = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE', 'owner', 'tilion'),
    health: async () => health('ready', 600_000),
    mintTilionLiveViewUrl,
  });
  const second = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE', 'owner', 'tilion'),
    health: async () => health('ready', 600_000),
    mintTilionLiveViewUrl,
  });
  assert.equal(first.live, true, 'Tilion `ready` is live');
  assert.notEqual(first.debugUrl, second.debugUrl, 'each read mints a fresh token');
  assert.match(second.debugUrl ?? '', /token=t2$/);

  const ended = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE', 'owner', 'tilion'),
    health: async () => health('expired', null),
    mintTilionLiveViewUrl,
  });
  const closed = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('CLOSED', 'owner', 'tilion'),
    health: async () => health('ready', 1),
    mintTilionLiveViewUrl,
  });
  assert.equal(ended.live, false);
  assert.equal(closed.live, false);
  const agedOut = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE', 'owner', 'tilion'),
    health: async () => {
      throw new TilionApiError({
        status: 404,
        slug: null,
        message: 'No such session',
        method: 'GET',
        path: '/v1/session/x/status',
        retryable: false,
        requestId: null,
        retryAfterMs: null,
        detail: 'No such session',
      });
    },
    mintTilionLiveViewUrl,
  });
  assert.equal(agedOut.live, false, 'a 404 Tilion record is ended, not unknown');
  assert.equal(mints, 2, 'ended Tilion sessions must not mint view tokens');

  const mintFailed = await getBrowserLiveView('task-live-view', 'owner', {
    findRecord: async () => liveViewRecord('ACTIVE', 'owner', 'tilion'),
    health: async () => health('ready', 600_000),
    mintTilionLiveViewUrl: async () => {
      throw new Error('mint unavailable');
    },
  });
  assert.equal(mintFailed.debugUrl, LIVE_URL, 'a failed mint keeps the stored URL');
}

async function runAll(): Promise<void> {
  await testActiveTakeControlIsImmediateSameSession();
  await testLeftoverRequestedBecomesUserOnSameSession();
  await testClosedRequestedDoesNotGrantUser();
  await testClosedUserDoesNotReportUser();
  await testClosedRequestedTransitionIsRejectedByStatusFilter();
  await testSecondBrowserHandoffDoesNotTouchTheFirst();
  await testLiveViewReportsProviderEndedSessionAsNotLive();
  await testLiveViewClosedRowSkipsProviderAndUnknownHealthIsNull();
  await testLiveViewHidesAnotherUsersTask();
  await testTilionLiveViewMintsFreshUrlAndEndedIsNotLive();
  await prisma.$disconnect();
  process.stdout.write('PASS browser-session-control unit (10 cases)\n');
}

runAll().catch(async (error) => {
  process.stderr.write(`FAIL browser-session-control unit ${String(error)}\n`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
