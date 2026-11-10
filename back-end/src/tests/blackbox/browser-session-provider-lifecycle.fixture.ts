import { assertHydrationRecovery } from './browser-session-hydration-recovery.fixture-support';
import {
  populateLifecycleState,
  assertLifecycleState,
  lifecycleUrls,
  createLifecyclePopupRace,
  connectLifecycleCheckpointBrowser,
  assertLifecyclePopupIsolation,
  assertLifecycleCheckpointReceipt,
  assertLifecycleCheckpointAvailable,
  assertLifecycleFrameCheckpoint,
  assertLifecycleResumeHealth,
  captureLifecycleCheckpoint,
  selectLifecycleCheckpointFormat,
} from './browser-session-state.fixture-support';
/** Shared logical lifecycle contract: real Chromium state and local Prisma; native provider I/O is owned. */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import {
  within,
  spawnLifecycleWorker,
  allocateLifecycleNative,
  registerLifecycleServiceWorker,
  lifecycleTransport,
  lifecycleNativeHealth,
} from './browser-session-lifecycle.fixture-support';
import { prisma } from '../../providers/database';
import type { Prisma } from '@prisma/client';

const local = createRequire(import.meta.url);
const originalLoad = Module._load;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    `external network forbidden: ${url.hostname}`
  );
  return originalFetch(input, init);
}) as typeof fetch;
const natives = new Map<string, Browser>();
const nativeEndpoints = new Map<string, string>();
const released: string[] = [];
let creates = 0;
let provider = 'steel';
let unknownHealth = false;
let healthTtlMs = 1_800_000;
let enteredAllocation: (() => void) | undefined;
let allocationGate: Promise<void> = Promise.resolve();
let releaseAllocation: (() => void) | undefined;
const children = new Set<ChildProcess>();
const childClosures: Promise<void>[] = [];
const nativeRequests = new Set<Promise<void>>();
async function stopWorkers() {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(childClosures);
  releaseAllocation?.();
  await Promise.all(nativeRequests);
}
let checkpointOriginRequests = 0;
let checkpointFailure: 'write' | 'readback' | null = null;
let afterCheckpoint: (() => Promise<void>) | undefined;
let rejectCreate = false;
let failHydration = false;
let failNavigation = false;
let failRelease = false;
let onCreate: (() => Promise<void>) | undefined;
const checkpointPopupRace = createLifecyclePopupRace();
const updateSession = prisma.browserSession.updateMany.bind(prisma.browserSession);
prisma.browserSession.updateMany = (async (args) => {
  const result = await updateSession(args);
  if (args.data.checkpointRef && afterCheckpoint) {
    const callback = afterCheckpoint;
    afterCheckpoint = undefined;
    await callback();
  }
  return result;
}) as typeof updateSession;
const transaction = prisma.$transaction.bind(prisma);
prisma.$transaction = (async (...args: unknown[]) => {
  const callback = args[0];
  if (typeof callback !== 'function') return Reflect.apply(transaction, prisma, args);
  let published = false;
  const wrapped = async (tx: Prisma.TransactionClient) => {
    const update = tx.browserSession.updateMany.bind(tx.browserSession);
    tx.browserSession.updateMany = (async (input) => {
      const result = await update(input);
      if (input.data.checkpointRef) published = true;
      return result;
    }) as typeof update;
    return callback(tx);
  };
  const result = await Reflect.apply(transaction, prisma, [wrapped, ...args.slice(1)]);
  if (published && afterCheckpoint) {
    const observe = afterCheckpoint;
    afterCheckpoint = undefined;
    await observe();
  }
  return result;
}) as typeof prisma.$transaction;
function worker(taskId: string, origin: string, joined?: () => void) {
  const result = spawnLifecycleWorker(taskId, provider, origin, joined);
  children.add(result.child);
  void result.closed.then(() => children.delete(result.child));
  childClosures.push(result.closed);
  return result;
}
const transport = (browser: Browser) =>
  lifecycleTransport(
    browser,
    () => failHydration,
    () => failNavigation
  );
const allocate = () => allocateLifecycleNative(natives, nativeEndpoints);
async function closeNative(id: string, pause: boolean) {
  assert.equal(pause, false, 'logical pause must release the native resource');
  await releaseNativeCandidate(id);
  await prisma.browserSession.update({
    where: { sessionId: id },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
}
/** Provider-level release of one exact native (no row bookkeeping), as sessionCleanup uses it. */
async function releaseNativeCandidate(id: string) {
  if (failRelease) throw new Error('fixture native release outcome unknown');
  await natives.get(id)?.close();
  natives.delete(id);
  released.push(id);
}
async function resumeNative(taskId: string) {
  const { browserResumeScope, resumeNativeCreate } = local('../../providers/steel/lifecycleClaim');
  const scope = browserResumeScope();
  assert(scope, 'every provider restore must own durable resume custody');
  await scope.beforeCreate(provider);
  const { id, browser } = await resumeNativeCreate(async () => {
    await onCreate?.();
    if (rejectCreate) {
      rejectCreate = false;
      throw Object.assign(new Error('fixture rate limit'), { status: 429 });
    }
    creates++;
    return allocate();
  });
  const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  await prisma.browserSession.update({
    where: { id: taskId },
    data: {
      sessionId: id,
      wsUrl: id,
      debugUrl: 'https://fixture.invalid',
      status: 'PAUSED',
      closedAt: null,
    },
  });
  return {
    provider,
    sessionId: id,
    wsUrl: id,
    debugUrl: 'https://fixture.invalid',
    savedUrl: row.currentUrl!,
    proxySource: 'fixture',
    proxyLocation: { country: 'US' },
    profileId: null,
    profileSource: 'logical_checkpoint',
    validationBrowser: transport(browser),
    previousSessionId: null,
    previousProvider: provider,
    previousSessionReleased: true,
  };
}
Module._load = function (id, parent, isMain) {
  const owner = parent?.filename ?? '';
  if (owner.endsWith('/browser/checkpoint.ts') && id === '../codeSessions/artifactStore') {
    const actual = originalLoad.call(this, id, parent, isMain);
    return {
      ...actual,
      putCheckpointObject: async (...args: unknown[]) => {
        if (checkpointFailure === 'write') throw new Error('fixture checkpoint write failed');
        return actual.putCheckpointObject(...args);
      },
      getCheckpointObject: async (...args: unknown[]) =>
        checkpointFailure === 'readback'
          ? Buffer.from('corrupt')
          : actual.getCheckpointObject(...args),
    };
  }
  if (owner.endsWith('/browser/index.ts')) {
    const health = async (id: string) =>
      lifecycleNativeHealth(provider, id, unknownHealth, natives.has(id), healthTtlMs);
    if (id === './kernel')
      return {
        closeKernelSession: closeNative,
        resumeKernelSession: resumeNative,
        getKernelSessionHealth: health,
      };
    if (id === '../steel/sessionInspect') return { getSteelSessionHealth: health };
    if (id === './browserUse')
      return { closeBrowserUseSession: closeNative, resumeBrowserUseSession: resumeNative };
    if (id === '../steel/session')
      return { closeSession: closeNative, resumeSession: resumeNative };
  }
  if (owner.endsWith('/browser/sessionCleanup.ts')) {
    if (id === './kernelSessionDelete')
      return { releaseKernelRemoteSession: releaseNativeCandidate };
    if (id === '../steel/session') return { releaseSteelRemoteSession: releaseNativeCandidate };
    if (id === './browserUse') return { releaseBrowserUseRemoteSession: releaseNativeCandidate };
    if (id === './tilion') return { releaseTilionRemoteSession: releaseNativeCandidate };
  }
  if (owner.endsWith('/browser/checkpoint.ts') && id === '../steel/sessionConnection')
    return {
      connectValidatedBrowser: (id: string) =>
        connectLifecycleCheckpointBrowser(id, nativeEndpoints, checkpointPopupRace),
    };
  return originalLoad.call(this, id, parent, isMain);
};

(async () => {
  const db = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(db.hostname));
  const server = createServer(async (req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(
        `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname.startsWith('/.rose-checkpoint-'))e.respondWith(fetch('/checkpoint-origin-action').then(()=>new Response('<!doctype html>')));});`
      );
      return;
    }
    if (req.url === '/checkpoint-origin-action') {
      checkpointOriginRequests++;
      res.end('effect');
      return;
    }
    if (req.url === '/allocate') {
      const work = (async () => {
        creates++;
        const native = await allocate();
        enteredAllocation?.();
        await allocationGate;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: native.id, endpoint: nativeEndpoints.get(native.id) }));
      })();
      nativeRequests.add(work);
      try {
        await work;
      } finally {
        nativeRequests.delete(work);
      }
      return;
    }
    if (req.url?.startsWith('/health?')) {
      res.setHeader('Content-Type', 'application/json');
      const id = new URL(req.url, 'http://localhost').searchParams.get('id')!;
      res.end(JSON.stringify(lifecycleNativeHealth(provider, id, false, true, 1800000)));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>state fixture</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const { closeSession } = local('../../providers/browser');
  const { resumeBrowserSession } = local('../../providers/browserSessionResume');
  const { readBrowserCheckpoint } = local('../../providers/browser/checkpoint');
  try {
    for (provider of ['steel', 'kernel']) {
      const userId = `logical-lifecycle-${randomUUID()}`;
      await prisma.user.create({ data: { userId, isAnonymous: true } });
      const context = await prisma.browserContext.create({ data: { userId } });
      const first = await allocate();
      const row = await prisma.browserSession.create({
        data: {
          contextId: context.id,
          agentId: userId,
          logicalOwnerKey: `agent:${userId}`,
          provider,
          sessionId: first.id,
          wsUrl: first.id,
          debugUrl: 'https://fixture.invalid',
          status: 'ACTIVE',
          baselineCheckpointRef: 'browser-checkpoint:empty:v1',
          startUrl: lifecycleUrls(origin)[0],
          currentUrl: lifecycleUrls(origin)[0],
        },
      });
      try {
        await populateLifecycleState(first.browser, origin);
        // Exercise the existing internal checkpoint owner; this bundle does not
        // add the peer's optional live-checkpoint HTTP API.
        const checkpointBrowserSession = captureLifecycleCheckpoint;
        assertLifecycleCheckpointAvailable(checkpointBrowserSession);
        const checkpointOnly = await checkpointBrowserSession(row.id, first.id);
        assertLifecycleCheckpointReceipt(checkpointOnly, row.id, first.id);
        const initialCheckpointRow = await prisma.browserSession.findUniqueOrThrow({
          where: { id: row.id },
        });
        const initialCheckpoint = await readBrowserCheckpoint(
          userId,
          initialCheckpointRow.checkpointRef!
        );
        assertLifecycleFrameCheckpoint(initialCheckpoint);
        assert(natives.has(first.id));
        assert.equal(
          (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
          'ACTIVE'
        );
        await assertLifecyclePopupIsolation(first.browser, origin, checkpointPopupRace, () =>
          checkpointBrowserSession(row.id, first.id)
        );
        await registerLifecycleServiceWorker(first.browser.contexts()[0]!.pages()[0]!);
        const exerciseWorker = () =>
          first.browser
            .contexts()[0]!
            .pages()[0]!
            .evaluate(() => fetch('/.rose-checkpoint-control').then((r) => r.text()));
        await exerciseWorker();
        assert.equal(
          checkpointOriginRequests,
          1,
          'control proves the origin service worker is active'
        );
        checkpointOriginRequests = 0;
        for (const failure of ['write', 'readback'] as const) {
          checkpointFailure = failure;
          await assert.rejects(closeSession(first.id, true), /checkpoint/);
          checkpointFailure = null;
          assert(natives.has(first.id), 'failed checkpoint must not release the native');
          assert.equal(
            (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
            'ACTIVE'
          );
        }
        assert.deepEqual(
          first.browser
            .contexts()[0]!
            .pages()
            .map((p) => p.url())
            .sort(),
          [...lifecycleUrls(origin)].sort(),
          'failed capture closes private pages without navigating existing tabs'
        );
        await exerciseWorker();
        assert.equal(
          checkpointOriginRequests,
          1,
          'capture must not disable the original tab service worker'
        );
        checkpointOriginRequests = 0;
        for (let cycle = 0; cycle < 2; cycle++) {
          const before = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
          await closeSession(before.sessionId!, true);
          assert.equal(
            checkpointOriginRequests,
            0,
            'checkpoint capture must not execute an origin service worker action'
          );
          const paused = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
          assert.equal(paused.status, 'PAUSED');
          assert(paused.checkpointRef);
          assert(released.includes(before.sessionId!));
          const checkpoint = await readBrowserCheckpoint(userId, paused.checkpointRef);
          assert.equal(checkpoint.tabs.length, 2);
          assert(checkpoint.storage.cookies.some((c) => c.name === 'contract'));
          assert(
            checkpoint.storage.origins.some(
              (o) =>
                o.origin === origin &&
                o.localStorage.some((s) => s.name === 'contract' && s.value === 'local')
            ),
            'reattached checkpoint must capture existing origin storage'
          );
          // Both deployed version-1 sessionStorage representations must remain
          // readable. Keep persistent frame state while selecting its SS shape.
          await selectLifecycleCheckpointFormat(checkpoint, cycle, row.id);
          const count = creates;
          const [a, b] = await Promise.all([
            resumeBrowserSession(row.id),
            resumeBrowserSession(row.id),
          ]);
          assert.equal(a.task_id, row.id);
          assert.equal(a.session_id, b.session_id);
          assertLifecycleResumeHealth(a, b);
          assert.notEqual(a.session_id, before.sessionId);
          assert.equal(creates, count + 1);
          const active = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
          assert.equal(active.status, 'ACTIVE');
          await assertLifecycleState(natives.get(a.session_id)!, origin);
        }
        const expiring = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
        const expiringPage = natives
          .get(expiring.sessionId!)!
          .contexts()[0]!
          .pages()
          .find((p) => p.url() === lifecycleUrls(origin)[0])!;
        await expiringPage.evaluate(() =>
          localStorage.setItem('late-before-expiry', 'must-survive')
        );
        healthTtlMs = 1;
        const beforeControlRace = creates;
        afterCheckpoint = async () => {
          const { setBrowserControlState } = local('../../domains/browser-session/service.control');
          await setBrowserControlState(row.id, 'user', userId);
        };
        await assert.rejects(resumeBrowserSession(row.id), /control|ownership/i);
        assert.equal(
          creates,
          beforeControlRace,
          'user control acquired during source capture prevents allocation'
        );
        assert.equal(
          (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).sessionId,
          expiring.sessionId
        );
        await prisma.browserSession.update({
          where: { id: row.id },
          data: { controlState: 'AGENT', controlLeaseExpiresAt: null },
        });
        let acquiredDuringCreate = false;
        onCreate = async () => {
          const { setBrowserControlState } = local('../../domains/browser-session/service.control');
          try {
            await setBrowserControlState(row.id, 'user', userId);
            acquiredDuringCreate = true;
          } catch (error) {
            assert.match(String(error), /unavailable/);
          }
        };
        const replacedExpiring = await resumeBrowserSession(row.id);
        onCreate = undefined;
        assert.equal(
          acquiredDuringCreate,
          false,
          'native create must not race a grant of source user control'
        );
        healthTtlMs = 1_800_000;
        const replacementPage = natives
          .get(replacedExpiring.session_id)!
          .contexts()[0]!
          .pages()
          .find((p) => p.url() === lifecycleUrls(origin)[0])!;
        assert.equal(
          await replacementPage.evaluate(() => localStorage.getItem('late-before-expiry')),
          'must-survive',
          'live expiry handoff checkpoints the latest native state before replacing it'
        );
        const beforeControl = await prisma.browserSession.findUniqueOrThrow({
          where: { id: row.id },
        });
        let controlAcquired = false;
        afterCheckpoint = async () => {
          const { setBrowserControlState } = local('../../domains/browser-session/service.control');
          try {
            await setBrowserControlState(row.id, 'user', userId);
            controlAcquired = true;
          } catch (error) {
            assert.match(String(error), /unavailable/);
          }
        };
        await closeSession(beforeControl.sessionId!, true);
        assert.equal(
          controlAcquired,
          false,
          'user control cannot be granted after pause retirement begins'
        );
        rejectCreate = true;
        const countBeforeReject = creates;
        await assert.rejects(resumeBrowserSession(row.id), /rate limit/);
        assert.equal(creates, countBeforeReject, 'typed rejected create has no allocation');
        await resumeBrowserSession(row.id);
        const beforeWorkers = await prisma.browserSession.findUniqueOrThrow({
          where: { id: row.id },
        });
        await closeSession(beforeWorkers.sessionId!, true);
        let release!: () => void;
        allocationGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        releaseAllocation = release;
        const entered = new Promise<void>((resolve) => {
          enteredAllocation = resolve;
        });
        const firstWorker = worker(row.id, origin);
        await firstWorker.ready.then(() => within(entered));
        const countBeforeJoin = creates;
        const secondWorker = worker(row.id, origin, release);
        const [firstId, secondId] = await secondWorker.ready.then(() =>
          within(Promise.all([firstWorker.result, secondWorker.result]))
        );
        await Promise.all([firstWorker.closed, secondWorker.closed]);
        assert.equal(firstId, secondId, 'separate processes must join one native restoration');
        assert.equal(creates, countBeforeJoin, 'follower must not allocate');
        // Validate the worker-created pages through a new consumer connection.
        const consumer = await chromium.connectOverCDP(nativeEndpoints.get(firstId)!);
        try {
          await assertLifecycleState(consumer, origin);
        } finally {
          await consumer.close();
        }
        allocationGate = Promise.resolve();
        enteredAllocation = undefined;
        failRelease = true;
        await assert.rejects(closeSession(firstId, true), /release outcome unknown/);
        failRelease = false;
        assert.equal(
          (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
          'ERROR',
          'unconfirmed release must remain fenced'
        );
        const countBeforeRelease = creates;
        unknownHealth = true;
        await assert.rejects(resumeBrowserSession(row.id), /release outcome/);
        unknownHealth = false;
        assert.equal(creates, countBeforeRelease);
        await natives.get(firstId)!.close();
        natives.delete(firstId);
        await resumeBrowserSession(row.id);
        const { getTaskInfo } = local('../../domains/browser-session/service.task-info');
        const beforeExpiry = await prisma.browserSession.findUniqueOrThrow({
          where: { id: row.id },
        });
        unknownHealth = true;
        assert.equal(
          (await getTaskInfo(row.id, { validateLive: true })).status,
          'ACTIVE',
          'unknown health is not confirmed expiry'
        );
        unknownHealth = false;
        await natives.get(beforeExpiry.sessionId!)!.close();
        natives.delete(beforeExpiry.sessionId!);
        const ended = await getTaskInfo(row.id, { validateLive: true });
        assert.equal(ended.status, 'PAUSED', 'confirmed native end pauses logical task');
        assert.equal(ended.same_session_available, false);
        assert.equal(
          (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).checkpointRef,
          beforeExpiry.checkpointRef
        );
        const createsBeforeMissing = creates;
        await prisma.browserSession.update({
          where: { id: row.id },
          data: { checkpointRef: null },
        });
        await assert.rejects(
          resumeBrowserSession(row.id),
          /checkpoint/i,
          'materialized browser cannot silently restore an empty baseline'
        );
        assert.equal(
          creates,
          createsBeforeMissing,
          'missing saved state must fail before allocation'
        );
        await prisma.browserSession.update({
          where: { id: row.id },
          data: { checkpointRef: beforeExpiry.checkpointRef },
        });
        await assertHydrationRecovery({
          taskId: row.id,
          origin,
          creates: () => creates,
          resume: () => resumeBrowserSession(row.id),
          pause: (id) => closeSession(id, true),
          natives,
          released,
          setFaults: ({ navigation, storage, release }) => {
            if (navigation !== undefined) failNavigation = navigation;
            if (storage !== undefined) failHydration = storage;
            if (release !== undefined) failRelease = release;
          },
        });
        process.stdout.write(`PASS shared logical pause/resume ${provider}\n`);
      } finally {
        await stopWorkers();
        const current = await prisma.browserSession.findUnique({ where: { id: row.id } });
        if (current?.sessionId) {
          await natives.get(current.sessionId)?.close();
          natives.delete(current.sessionId);
        }
        await prisma.toolSideEffect.deleteMany({
          where: { operationKey: `steel-browser-task-lifecycle:${row.id}` },
        });
        await prisma.browserContext.delete({ where: { id: context.id } });
        await prisma.user.delete({ where: { userId } });
      }
    }
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    checkpointFailure = null;
    afterCheckpoint = undefined;
    failHydration = false;
    failNavigation = false;
    failRelease = false;
    await stopWorkers();
    for (const browser of natives.values()) await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
