import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Request, Response as ExpressResponse, RequestHandler, Router } from 'express';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { registerBrowserChallengeRecoveryRoutes } from '../../domains/browser-session/routes.challenge-recovery';
import { searchAndPromoteBrowserConfig } from '../../providers/browser/challengeRecoveryPromote';
import { browserConfigSearchRuntimeDependencies as runtime } from '../../providers/browser/challengeRecovery';
import { liveRecoveryProbeSessionCount } from '../../providers/browser/challengeRecoveryLaneSearch';

// No provider, database, model, or HTTP connection is permitted by this fixture.
net.Socket.prototype.connect = function () {
  throw new Error('network forbidden');
} as typeof net.Socket.prototype.connect;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const taskId = '11111111-1111-4111-8111-111111111111';
const old = 'old-tilion-session';
let row: Record<string, unknown>, released: string[], announcements: number, updates: number;
let onUpdate: (() => void) | undefined;
let onAnnounce: (() => void) | undefined;
let createGate: ReturnType<typeof deferred<void>> | undefined;
let probeGate: ReturnType<typeof deferred<void>> | undefined;
let entered = deferred<void>();
const reset = () => {
  row = {
    id: taskId,
    agentId: taskId,
    sessionId: old,
    contextId: 'context',
    provider: 'tilion',
    proxyTier: 'direct',
    context: {},
  };
  released = [];
  announcements = 0;
  updates = 0;
  onUpdate = undefined;
  onAnnounce = undefined;
  createGate = undefined;
  probeGate = undefined;
  entered = deferred<void>();
};
const originalRuntime = { ...runtime };
const original = {
  findFirst: prisma.browserSession.findFirst,
  findUnique: prisma.browserSession.findUnique,
  agent: prisma.agent.findUnique,
  transaction: prisma.$transaction,
  ...runtime,
};
Object.assign(prisma.browserSession, { findFirst: async () => row });
Object.assign(prisma.browserSession, { findUnique: async () => row });
Object.assign(prisma.agent, { findUnique: async () => null });
Object.assign(prisma, {
  $transaction: async (
    body: (tx: {
      browserSession: {
        updateMany: (input: { data: Record<string, unknown> }) => Promise<{ count: number }>;
      };
      browserContext: { update: () => Promise<object> };
    }) => Promise<unknown>
  ) => {
    const before = { ...row };
    try {
      return await body({
        browserSession: {
          updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            updates++;
            row = { ...row, ...data };
            onUpdate?.();
            return { count: 1 };
          },
        },
        browserContext: { update: async () => ({}) },
      });
    } catch (error) {
      row = before;
      throw error;
    }
  },
});
const create = async () => {
  entered.resolve();
  if (createGate) await createGate.promise;
  return {
    sessionId: 'new-kernel-session',
    debugUrl: 'https://fixture.invalid/live',
    wsUrl: 'wss://fixture.invalid/cdp',
    proxySource: 'fixture',
    proxyLocation: { country: 'US' },
    profileId: null,
    profileSource: 'fixture',
    validationBrowser: { close: async () => {}, isConnected: () => false },
  } as unknown as {
    sessionId: string;
    debugUrl: string;
    wsUrl: string;
    proxySource: string;
    proxyLocation: { country: string };
    profileId: null;
    profileSource: string;
    validationBrowser: Browser;
  };
};
Object.assign(runtime, {
  createKernel: create,
  createSteel: create,
  createBrowserUse: create,
  createTilion: create,
  releaseKernel: async (id: string) => {
    released.push(id);
  },
  releaseSteel: async (id: string) => {
    released.push(id);
  },
  releaseBrowserUse: async (id: string) => {
    released.push(id);
  },
  releaseTilion: async (id: string) => {
    released.push(id);
  },
  announceBinding: async () => {
    announcements++;
    onAnnounce?.();
  },
  probe: async () => {
    entered.resolve();
    if (probeGate) await probeGate.promise;
    return { stablePasses: 1, attempts: 1, latencyMs: 1 };
  },
});
let handler: RequestHandler;
registerBrowserChallengeRecoveryRoutes({
  get: () => {},
  post: (path: string, ...handlers: RequestHandler[]) => {
    if (path === '/recover-challenge') handler = handlers.at(-1)!;
  },
} as unknown as Router);
class Response extends EventEmitter {
  writableFinished = false;
  destroyed = false;
  body: { success?: boolean } | undefined;
  error: unknown;
  done = deferred<void>();
  status() {
    return this;
  }
  json(body: { success?: boolean }) {
    this.body = body;
    this.writableFinished = true;
    this.done.resolve();
    return this;
  }
  disconnect() {
    this.destroyed = true;
    this.emit('close');
  }
}
const launch = (response: Response) =>
  handler(
    {
      isInternal: true,
      body: { task_id: taskId, current_url: 'https://example.test/', storage_state: {} },
    } as Request,
    response as unknown as ExpressResponse,
    (error: unknown) => {
      response.error = error;
      response.done.resolve();
    }
  );
async function waitReleased() {
  for (let i = 0; i < 30 && released.length === 0; i++) await tick();
  assert.ok(released.length > 0, 'candidate must be released');
}
async function main() {
  try {
    reset();
    const normal = new Response();
    launch(normal);
    await normal.done.promise;
    assert.equal(normal.body?.success, true);
    assert.equal(row.sessionId, 'new-kernel-session');
    assert.deepEqual(released, [old]);
    assert.equal(announcements, 1);
    normal.emit('close');
    assert.equal(normal.listenerCount('close'), 0, 'normal response detaches listener');

    reset();
    probeGate = deferred<void>();
    const closed = new Response();
    launch(closed);
    await entered.promise;
    await tick();
    closed.disconnect();
    probeGate.resolve();
    await waitReleased();
    await tick();
    assert.equal(row.sessionId, old, 'late probe must not promote after caller disconnect');
    assert.equal(updates, 0);
    assert.equal(announcements, 0);
    assert.ok(!released.includes(old));
    assert.equal(closed.body, undefined);
    assert.equal(liveRecoveryProbeSessionCount(), 0);

    reset();
    createGate = deferred<void>();
    const lateCreate = new Response();
    launch(lateCreate);
    await entered.promise;
    lateCreate.disconnect();
    createGate.resolve();
    await waitReleased();
    await tick();
    assert.equal(row.sessionId, old);
    assert.equal(updates, 0);
    assert.ok(!released.includes(old));
    assert.equal(liveRecoveryProbeSessionCount(), 0);

    reset();
    const cancelled = new Response();
    cancelled.disconnect();
    launch(cancelled);
    await tick();
    await tick();
    assert.equal(updates, 0);
    assert.deepEqual(released, []);

    reset();
    const abort = new AbortController();
    onUpdate = () => abort.abort();
    await assert.rejects(
      searchAndPromoteBrowserConfig(
        {
          taskId,
          targetUrl: 'https://example.test/',
          storageState: {},
          fingerprintInjection: null,
          signal: abort.signal,
        },
        runtime
      )
    );
    assert.equal(row.sessionId, old, 'cancel during transaction rolls back');
    assert.ok(!released.includes(old));
    assert.equal(liveRecoveryProbeSessionCount(), 0);

    reset();
    const committed = new Response();
    onAnnounce = () => committed.disconnect();
    launch(committed);
    for (let i = 0; i < 30 && !released.includes(old); i++) await tick();
    assert.equal(row.sessionId, 'new-kernel-session');
    assert.deepEqual(released, [old], 'committed winner remains owned after late disconnect');
    assert.equal(liveRecoveryProbeSessionCount(), 0);

    reset();
    const success = await searchAndPromoteBrowserConfig(
      { taskId, targetUrl: 'https://example.test/', storageState: {}, fingerprintInjection: null },
      runtime
    );
    assert.equal(success.session_id, 'new-kernel-session', 'legacy no-signal caller unchanged');
    process.stdout.write(
      'PASS 7 actual route/service/search cancellation and ownership controls\n'
    );
  } finally {
    Object.assign(prisma.browserSession, {
      findFirst: original.findFirst,
      findUnique: original.findUnique,
    });
    Object.assign(prisma.agent, { findUnique: original.agent });
    Object.assign(prisma, { $transaction: original.transaction });
    Object.assign(runtime, originalRuntime);
  }
}
void main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
