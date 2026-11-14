/** A disconnected checkpoint caller must not strand a live browser's lifecycle owner. */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { assertDetachAndPageCloseCanDependOnEachOther } from './browser-session-capture-owner.cases';
import { chromium, type Browser } from 'playwright';
import { prisma } from '../../providers/database';
import {
  browserResumeScope,
  withBrowserResumeLifecycle,
} from '../../providers/browser/resumeLifecycle';
import { launchLifecycleNative, within } from './browser-session-lifecycle.fixture-support';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Pause = <T>(
  logical: { id: string; logicalOwnerKey: string | null },
  sessionId: string,
  pause: boolean,
  perform: (providerPause: boolean) => Promise<T>,
  signal?: AbortSignal
) => Promise<T>;

export async function runBrowserPauseAbortCases(): Promise<void> {
  await assertDetachAndPageCloseCanDependOnEachOther();
  const database = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(database.hostname));
  assert.match(database.pathname, /^\/victoria_[\w-]+$/);
  const require = createRequire(import.meta.url);
  const checkpointPath = new URL('../../providers/browser/checkpoint.ts', import.meta.url).pathname;
  const pausePath = new URL('../../providers/browser/logicalPause.ts', import.meta.url).pathname;
  const loader = Module as unknown as {
    _load: (id: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  const cached = [require.cache[checkpointPath], require.cache[pausePath]];
  const environment = {
    CLAUDE_CREDENTIAL_DECRYPTION_KEY: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
    CODE_SESSION_STORAGE_BACKEND: process.env.CODE_SESSION_STORAGE_BACKEND,
    CODE_SESSION_STORAGE_LOCAL_DIR: process.env.CODE_SESSION_STORAGE_LOCAL_DIR,
  };
  const directory = await mkdtemp(join(tmpdir(), 'pause-abort-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' })
  ).toString('base64');
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = directory;
  const connections: Browser[] = [];
  let holdCapture = true;
  let holdStorage = false;
  let failClosedScratch = false;
  let storageGate:
    | {
        entered: ReturnType<typeof deferred<void>>;
        finish: ReturnType<typeof deferred<void>>;
        scratchClosed: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  let finishRelease: ReturnType<typeof deferred<void>> | undefined;
  let closeGate:
    | { entered: ReturnType<typeof deferred<void>>; finish: ReturnType<typeof deferred<void>> }
    | undefined;
  let entered = deferred<void>();
  let captureSettled = deferred<void>();
  let pendingClose: Promise<unknown> | undefined;
  let contextId: string | undefined;
  let taskId: string | undefined;
  let ownerBrowser: Browser | undefined;
  const userId = `pause-abort-${randomUUID()}`;
  const server = createServer((_req, res) =>
    res.end('<!doctype html><title>private checkout</title>')
  );
  loader._load = function (id, parent, isMain) {
    if (parent?.filename === checkpointPath && id === '../steel/sessionConnection') {
      return {
        connectValidatedBrowser: async (endpoint: string) => {
          const browser = await chromium.connectOverCDP(endpoint);
          connections.push(browser);
          const close = browser.close.bind(browser);
          if (closeGate) {
            const gate = closeGate;
            browser.close = async (...args) => {
              gate.entered.resolve();
              await gate.finish.promise;
              await close(...args);
            };
          }
          if (storageGate) {
            const gate = storageGate;
            const context = browser.contexts()[0]!;
            const storageState = context.storageState.bind(context);
            context.storageState = async (...args) => {
              const scratch = context
                .pages()
                .find((page) => page.url().includes('.rose-checkpoint-'));
              assert(scratch);
              scratch.once('close', () => gate.scratchClosed.resolve());
              gate.entered.resolve();
              await gate.finish.promise;
              return storageState(...args);
            };
          }
          if (holdStorage) {
            const context = browser.contexts()[0]!;
            context.storageState = async () => {
              const scratch = context
                .pages()
                .find((page) => page.url().includes('.rose-checkpoint-'));
              assert(scratch, 'storage capture reaches its exact scratch target');
              if (failClosedScratch) {
                const close = scratch.close.bind(scratch);
                scratch.close = async (...args) => {
                  await close(...args);
                  throw new Error('fixture confirmed scratch close failure');
                };
              }
              // Wait for renderer admission, not merely the client method invocation.
              const admitted = scratch.waitForEvent('console', {
                predicate: (message) => message.text() === 'fixture-capture-entered',
              });
              const pending = scratch.evaluate(
                () =>
                  new Promise(() => {
                    console.log('fixture-capture-entered');
                  })
              );
              void pending.catch(() => {});
              await admitted;
              entered.resolve();
              try {
                await pending;
              } finally {
                captureSettled.resolve();
              }
              throw new Error('fixture storage capture unexpectedly returned');
            };
          }
          if (holdCapture) {
            const frame = browser
              .contexts()[0]!
              .pages()
              .find((p) => /^http:/.test(p.url()))!
              .mainFrame();
            const evaluate = frame.evaluate.bind(frame);
            let first = true;
            frame.evaluate = async (...args: Parameters<typeof frame.evaluate>) => {
              if (!first) return evaluate(...args);
              first = false;
              // This is a real pending Runtime.callFunctionOn, not a mock rejection.
              // Closing this exact CDP client must reject and settle its capture.
              const pending = evaluate('new Promise(() => {})');
              entered.resolve();
              try {
                return await pending;
              } finally {
                captureSettled.resolve();
              }
            };
          }
          return browser;
        },
      };
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    delete require.cache[checkpointPath];
    delete require.cache[pausePath];
    const { withLogicalBrowserPause } = require(pausePath) as { withLogicalBrowserPause: Pause };
    const { readBrowserCheckpoint } = require(
      checkpointPath
    ) as typeof import('../../providers/browser/checkpoint');
    await prisma.user.create({ data: { userId, isAnonymous: true } });
    const context = await prisma.browserContext.create({ data: { userId } });
    contextId = context.id;
    const native = await launchLifecycleNative();
    ownerBrowser = native.browser;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const page = await ownerBrowser.contexts()[0]!.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/checkout`);
    await page.evaluate(() => {
      localStorage.setItem('private-cart', 'retained');
      sessionStorage.setItem('private-step', 'payment');
    });
    const row = await prisma.browserSession.create({
      data: {
        contextId,
        agentId: randomUUID(),
        logicalOwnerKey: `agent:${randomUUID()}`,
        provider: 'tilion',
        sessionId: `sess_${randomUUID()}`,
        wsUrl: native.endpoint,
        status: 'ACTIVE',
        baselineCheckpointRef: 'browser-checkpoint:empty:v1',
        startUrl: page.url(),
        currentUrl: page.url(),
      },
    });
    taskId = row.id;
    const operationKey = `steel-browser-task-lifecycle:${row.id}`;
    let providerCloses = 0;
    const abort = new AbortController();
    pendingClose = withLogicalBrowserPause(
      row,
      row.sessionId!,
      true,
      async () => {
        providerCloses++;
      },
      abort.signal
    );
    void pendingClose.catch(() => {});
    await within(entered.promise);
    const held = await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } });
    assert.equal(held.status, 'STARTED', 'live caller retains exclusive checkpoint custody');
    assert.equal(providerCloses, 0, 'provider must stay live until checkpoint commits');
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'PAUSED'
    );
    // Preserve the reported downstream symptom through the real resume ledger.
    // Its production 30-second ownership wait is deliberately not shortened.
    await assert.rejects(
      withBrowserResumeLifecycle(row.id, {
        readBinding: () => prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } }),
        resume: async () => {
          throw new Error('live checkpoint must prevent provider allocation');
        },
        follow: async () => row.sessionId,
        compatibility: 'pause-abort-fixture',
        canFollow: async () => true,
        reuseCompleted: false,
        sourceEnded: () => false,
        inspect: async () => null,
        release: async () => false,
        ended: async () => false,
      }),
      /Browser resume is still in progress/
    );
    abort.abort(new Error('fixture caller disconnected'));
    await assert.rejects(
      within(pendingClose),
      /abort|disconnect/i,
      'caller abort must settle the pending checkpoint instead of retaining the lease'
    );
    await within(captureSettled.promise);
    assert.equal(connections[0]!.isConnected(), false, 'abort closes the exact capture CDP client');
    assert.equal(ownerBrowser.isConnected(), true, 'abort preserves the original native browser');
    assert.equal(providerCloses, 0, 'abort must not delete the live provider session');
    const after = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after.status, 'ACTIVE');
    assert.equal(after.sessionId, row.sessionId);
    assert.equal(after.checkpointRef, null);
    assert.equal(after.checkpointRevision, 0);
    assert.equal(
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
      'RELEASED'
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('private-cart')), 'retained');
    let creates = 0;
    const resumed = await within(
      withBrowserResumeLifecycle(row.id, {
        readBinding: () => prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } }),
        resume: async () => {
          creates++;
          // Existing live native: establish its binding through the real custody scope.
          await browserResumeScope()!.beforeHydration(row.sessionId!);
          return row.sessionId;
        },
        follow: async () => row.sessionId,
        compatibility: 'pause-abort-fixture',
        canFollow: async () => true,
        reuseCompleted: false,
        sourceEnded: () => false,
        inspect: async () => null,
        release: async () => false,
        ended: async () => false,
      })
    );
    assert.equal(resumed, row.sessionId, 'next owner is no longer blocked by the aborted capture');
    assert.equal(creates, 1);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error('fixture caller already disconnected'));
    const openedBeforeAbort = connections.length;
    await assert.rejects(
      withLogicalBrowserPause(
        row,
        row.sessionId!,
        true,
        async () => {
          providerCloses++;
        },
        alreadyAborted.signal
      ),
      /abort|disconnect/i
    );
    assert.equal(
      connections.length,
      openedBeforeAbort,
      'pre-aborted caller never opens capture CDP'
    );
    assert.equal(providerCloses, 0);
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'ACTIVE'
    );

    // Releasing custody requires confirmed transport cleanup, not merely starting close.
    holdCapture = true;
    entered = deferred<void>();
    captureSettled = deferred<void>();
    closeGate = { entered: deferred<void>(), finish: deferred<void>() };
    const cleanupAbort = new AbortController();
    pendingClose = withLogicalBrowserPause(
      row,
      row.sessionId!,
      true,
      async () => {
        providerCloses++;
      },
      cleanupAbort.signal
    );
    void pendingClose.catch(() => {});
    await within(entered.promise);
    cleanupAbort.abort(new Error('fixture disconnect with unconfirmed transport close'));
    await within(closeGate.entered.promise);
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'PAUSED',
      'unconfirmed CDP close cannot restore a reusable ACTIVE binding'
    );
    assert.equal(
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
      'STARTED',
      'unconfirmed CDP close retains the exact lifecycle owner'
    );
    closeGate.finish.resolve();
    await assert.rejects(within(pendingClose), /abort|disconnect/i);
    await within(captureSettled.promise);
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'ACTIVE'
    );
    closeGate = undefined;

    // A connected caller still commits private state before provider release.
    holdCapture = false;
    await withLogicalBrowserPause(row, row.sessionId!, true, async (providerPause) => {
      assert.equal(providerPause, false);
      const saved = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
      assert(saved.checkpointRef, 'provider release follows durable private checkpoint');
      assert.equal(saved.checkpointRevision, 1);
      const checkpoint = await readBrowserCheckpoint(userId, saved.checkpointRef);
      assert(
        checkpoint.storage.origins.some((origin) =>
          origin.localStorage.some(
            (entry) => entry.name === 'private-cart' && entry.value === 'retained'
          )
        )
      );
      providerCloses++;
    });
    assert.equal(providerCloses, 1);
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'PAUSED'
    );

    console.log('checkpoint abort control: explicit scratch');
    // Abort later in capture, with an existing private checkpoint and a scratch target.
    const prior = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
    await prisma.browserSession.update({ where: { id: row.id }, data: { status: 'ACTIVE' } });
    const targets = async () => {
      const cdp = await ownerBrowser!.newBrowserCDPSession();
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos
          .filter((target) => target.type === 'page')
          .map((target) => target.targetId)
          .sort();
      } finally {
        await cdp.detach();
      }
    };
    const originalTargets = await targets();
    holdStorage = true;
    entered = deferred<void>();
    captureSettled = deferred<void>();
    const storageAbort = new AbortController();
    pendingClose = withLogicalBrowserPause(
      row,
      row.sessionId!,
      true,
      async () => {
        providerCloses++;
      },
      storageAbort.signal
    );
    void pendingClose.catch(() => {});
    await within(entered.promise);
    storageAbort.abort(new Error('fixture caller disconnected during storage capture'));
    await assert.rejects(within(pendingClose), /abort|disconnect/i);
    await within(captureSettled.promise);
    const retained = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(retained.status, 'ACTIVE');
    assert.equal(
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
      'RELEASED'
    );
    assert.equal(
      retained.checkpointRef,
      prior.checkpointRef,
      'abort preserves previous private checkpoint'
    );
    assert.equal(retained.checkpointRevision, prior.checkpointRevision);
    assert.deepEqual(
      await targets(),
      originalTargets,
      'abort removes only its exact scratch target'
    );
    assert.equal(await page.evaluate(() => sessionStorage.getItem('private-step')), 'payment');
    assert.equal(providerCloses, 1);
    holdStorage = false;

    console.log('checkpoint abort control: confirmed-close error');
    // A reported scratch-close failure after actual closure must still disconnect capture.
    failClosedScratch = true;
    holdStorage = true;
    entered = deferred<void>();
    captureSettled = deferred<void>();
    const failedCleanup = new AbortController();
    pendingClose = withLogicalBrowserPause(
      row,
      row.sessionId!,
      true,
      async () => {
        providerCloses++;
      },
      failedCleanup.signal
    );
    void pendingClose.catch(() => {});
    await within(entered.promise);
    failedCleanup.abort(new Error('fixture abort with confirmed scratch close failure'));
    await assert.rejects(within(pendingClose), /confirmed scratch close failure|abort/i);
    assert.equal(
      connections.at(-1)!.isConnected(),
      false,
      'confirmed target-close error cannot skip transport cleanup'
    );
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'ACTIVE'
    );
    assert.equal(
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
      'RELEASED'
    );
    assert.deepEqual(await targets(), originalTargets);
    failClosedScratch = false;
    holdStorage = false;

    console.log('checkpoint abort control: admitted storage');
    // SDK work already admitted may still own hidden targets; keep custody until it settles.
    storageGate = {
      entered: deferred<void>(),
      finish: deferred<void>(),
      scratchClosed: deferred<void>(),
    };
    const admittedAbort = new AbortController();
    pendingClose = withLogicalBrowserPause(
      row,
      row.sessionId!,
      true,
      async () => {
        providerCloses++;
      },
      admittedAbort.signal
    );
    void pendingClose.catch(() => {});
    await within(storageGate.entered.promise);
    admittedAbort.abort(new Error('fixture disconnect during admitted SDK work'));
    await within(storageGate.scratchClosed.promise);
    assert.equal(
      connections.at(-1)!.isConnected(),
      true,
      'admitted SDK work retains its capture transport'
    );
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'PAUSED'
    );
    assert.equal(
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
      'STARTED'
    );
    storageGate.finish.resolve();
    await assert.rejects(within(pendingClose), /abort|disconnect/i);
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'ACTIVE'
    );
    assert.equal(
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
      'RELEASED'
    );
    assert.deepEqual(await targets(), originalTargets);
    storageGate = undefined;

    console.log('checkpoint abort control: provider release');
    // Once provider release begins, caller abort cannot roll its state back to ACTIVE.
    await prisma.browserSession.update({ where: { id: row.id }, data: { status: 'ACTIVE' } });
    const releasing = deferred<void>();
    finishRelease = deferred<void>();
    const finish = finishRelease;
    const lateAbort = new AbortController();
    pendingClose = withLogicalBrowserPause(
      row,
      row.sessionId!,
      true,
      async () => {
        releasing.resolve();
        await finish.promise;
        providerCloses++;
      },
      lateAbort.signal
    );
    await within(releasing.promise);
    lateAbort.abort(new Error('fixture caller disconnected after provider release began'));
    finish.resolve();
    await within(pendingClose);
    assert.equal(providerCloses, 2);
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).status,
      'PAUSED'
    );
    assert.equal(
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
      'RELEASED'
    );
    console.log(
      'PASS pending checkpoint caller abort, live caller custody, saved-state and late-abort controls'
    );
  } finally {
    // Even the pre-fix failing run must release the controlled CDP call and its DB owner.
    closeGate?.finish.resolve();
    finishRelease?.resolve();
    storageGate?.finish.resolve();
    await Promise.all(connections.map((connection) => connection.close().catch(() => {})));
    await pendingClose?.catch(() => {});
    await ownerBrowser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    if (taskId)
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: `steel-browser-task-lifecycle:${taskId}` },
      });
    if (contextId) await prisma.browserContext.delete({ where: { id: contextId } });
    await prisma.user.deleteMany({ where: { userId } });
    loader._load = originalLoad;
    for (const [index, path] of [checkpointPath, pausePath].entries()) {
      delete require.cache[path];
      if (cached[index]) require.cache[path] = cached[index];
    }
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
