/** Real CDP/DB/encrypted checkpoint regression for opaque iframe origins. */
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type Frame } from 'playwright';
import { prisma } from '../../providers/database';
import {
  checkpointLogicalBrowser,
  readBrowserCheckpoint,
  restoreLogicalBrowserCheckpoint,
} from '../../providers/browser/checkpoint';
import { withSteelLifecycleClaim } from '../../providers/steel/lifecycleClaim';
import { launchLifecycleNative } from './browser-session-lifecycle.fixture-support';

export async function runBrowserOpaqueFrameCheckpointCase(): Promise<void> {
  const db = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(db.hostname));
  assert.match(db.pathname, /^\/victoria_[\w-]+$/);
  const userId = `opaque-frame-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'opaque-checkpoint-'));
  const environment = {
    CLAUDE_CREDENTIAL_DECRYPTION_KEY: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
    CODE_SESSION_STORAGE_BACKEND: process.env.CODE_SESSION_STORAGE_BACKEND,
    CODE_SESSION_STORAGE_LOCAL_DIR: process.env.CODE_SESSION_STORAGE_LOCAL_DIR,
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' })
  ).toString('base64');
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = directory;
  let browser: Browser | undefined;
  let contextId: string | undefined;
  let taskId: string | undefined;
  const connections: Browser[] = [];
  const servers: Server[] = [];
  const serve = async () => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><body>checkpoint fixture</body>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  try {
    await prisma.user.create({ data: { userId, isAnonymous: true } });
    const context = await prisma.browserContext.create({ data: { userId } });
    contextId = context.id;
    const native = await launchLifecycleNative();
    browser = native.browser;
    const origin = await serve();
    const frameOrigin = await serve();
    const lateOrigin = await serve();
    const earlyOrigin = await serve();
    const browserContext = browser.contexts()[0]!;
    const page = await browserContext.newPage();
    await page.goto(`${origin}/checkout`);
    await page.evaluate(async (frameOrigin) => {
      localStorage.setItem('cart', 'one');
      sessionStorage.setItem('approval', 'held');
      await new Promise<void>((resolve) => {
        const frame = document.createElement('iframe');
        frame.sandbox.add('allow-scripts');
        frame.src = `${frameOrigin}/opaque`;
        frame.onload = () => resolve();
        document.body.append(frame);
      });
    }, frameOrigin);
    const opaque = page.frames().find((frame) => frame.url() === `${frameOrigin}/opaque`);
    assert(opaque);
    assert.deepEqual(
      await opaque.evaluate(() => {
        let forbidden = false;
        try {
          localStorage.getItem('x');
        } catch {
          forbidden = true;
        }
        return {
          securityOrigin: globalThis.origin,
          urlOrigin: location.origin,
          forbidden,
        };
      }),
      {
        securityOrigin: 'null',
        urlOrigin: frameOrigin,
        forbidden: true,
      }
    );
    const row = await prisma.browserSession.create({
      data: {
        contextId,
        agentId: randomUUID(),
        logicalOwnerKey: `agent:${randomUUID()}`,
        provider: 'kernel',
        sessionId: randomUUID(),
        wsUrl: native.endpoint,
        status: 'ACTIVE',
        baselineCheckpointRef: 'browser-checkpoint:empty:v1',
        startUrl: page.url(),
        currentUrl: page.url(),
      },
    });
    taskId = row.id;
    const capture = () =>
      withSteelLifecycleClaim(row.id, async (_owned, _effect, mutate) =>
        checkpointLogicalBrowser(row.sessionId!, mutate)
      );
    await page.evaluate(async (frameOrigin) => {
      await new Promise<void>((resolve) => {
        const frame = document.createElement('iframe');
        frame.id = 'transient';
        frame.src = `${frameOrigin}/transient`;
        frame.onload = () => resolve();
        document.body.append(frame);
      });
    }, frameOrigin);
    const transient = page.frames().find((frame) => frame.url() === `${frameOrigin}/transient`);
    assert(transient);
    await transient.evaluate(() => sessionStorage.setItem('unobserved-session', 'preserve-me'));
    // A first-checkpoint origin is discovered successfully, then leaves
    // during its second (IndexedDB) read. Its namespace must survive capture.
    await page.evaluate(async (lateOrigin) => {
      await new Promise<void>((resolve) => {
        const frame = document.createElement('iframe');
        frame.id = 'late-storage';
        frame.src = `${lateOrigin}/stored`;
        frame.onload = () => resolve();
        document.body.append(frame);
      });
    }, lateOrigin);
    const late = page.frames().find((frame) => frame.url() === `${lateOrigin}/stored`);
    assert(late);
    await late.evaluate(async () => {
      sessionStorage.setItem('late-session', 'retained');
      localStorage.setItem('late-local', 'retained');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('late-state', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('cart');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('cart', 'readwrite');
          transaction.objectStore('cart').put('retained', 'value');
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    });
    await page.evaluate(async (earlyOrigin) => {
      await new Promise<void>((resolve) => {
        const frame = document.createElement('iframe');
        frame.id = 'early-storage';
        frame.src = `${earlyOrigin}/stored`;
        frame.onload = () => resolve();
        document.body.append(frame);
      });
    }, earlyOrigin);
    const early = page.frames().find((frame) => frame.url() === `${earlyOrigin}/stored`);
    assert(early);
    await early.evaluate(async () => {
      sessionStorage.setItem('early-session', 'retained');
      localStorage.setItem('early-local', 'retained');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('early-state', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('cart');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('cart', 'readwrite');
          transaction.objectStore('cart').put('retained', 'value');
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    });
    // Schedule the same real detach seen on Shef after frames() enumerated
    // an iframe but before its storage read. Only control scheduling; keep
    // Playwright's actual detached-frame exception and the checkpoint path.
    const prototype = Object.getPrototypeOf(opaque) as Frame;
    const evaluate = prototype.evaluate;
    let detached = false;
    let firstStorageDetached = false;
    let detachedAfterStorage = false;
    prototype.evaluate = async function (this: Frame, ...args: Parameters<Frame['evaluate']>) {
      if (this.url() === `${frameOrigin}/transient` && !detached) {
        detached = true;
        const gone = this.page().waitForEvent('framedetached', (frame) => frame === this);
        await this.parentFrame()!.evaluate(() => document.querySelector('#transient')!.remove());
        await gone;
        assert(this.isDetached());
      }
      if (
        this.url() === `${earlyOrigin}/stored` &&
        String(args[0]).includes('Object.entries(storage)')
      ) {
        const gone = this.page().waitForEvent('framedetached', (frame) => frame === this);
        await this.parentFrame()!.evaluate(() =>
          document.querySelector('#early-storage')!.remove()
        );
        await gone;
        assert(this.isDetached());
        firstStorageDetached = true;
      }
      if (
        this.url() === `${lateOrigin}/stored` &&
        String(args[0]).includes('indexedDB.databases')
      ) {
        const gone = this.page().waitForEvent('framedetached', (frame) => frame === this);
        await this.parentFrame()!.evaluate(() => document.querySelector('#late-storage')!.remove());
        await gone;
        assert(this.isDetached());
        detachedAfterStorage = true;
      }
      return Reflect.apply(evaluate, this, args);
    } as Frame['evaluate'];
    try {
      await assert.rejects(capture(), /Frame was detached|frame was detached/i);
      assert(detached, 'the first origin probe must exercise a real detach');
      const unchanged = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(unchanged.checkpointRevision, row.checkpointRevision);
      assert.equal(unchanged.checkpointRef, row.checkpointRef);
      assert.equal(unchanged.sessionId, row.sessionId);
      assert.equal(unchanged.status, 'ACTIVE');
      const retainedConnection = await chromium.connectOverCDP(native.endpoint);
      connections.push(retainedConnection);
      const retainedTab = retainedConnection
        .contexts()[0]!
        .pages()
        .find((tab) => tab.url() === row.currentUrl);
      assert(retainedTab);
      await retainedTab.evaluate(async (frameOrigin) => {
        await new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = `${frameOrigin}/transient`;
          frame.onload = () => resolve();
          document.body.append(frame);
        });
      }, frameOrigin);
      const retainedFrame = retainedTab
        .frames()
        .find((frame) => frame.url() === `${frameOrigin}/transient`);
      assert(retainedFrame);
      assert.equal(
        await retainedFrame.evaluate(() => sessionStorage.getItem('unobserved-session')),
        'preserve-me'
      );
      await capture();
      assert(detached, 'the checkpoint must exercise the real detach race');
      assert(firstStorageDetached, 'the first storage read must exercise an actual iframe detach');
      assert(
        detachedAfterStorage,
        'the first checkpoint must detach after successful DOM storage capture'
      );
    } finally {
      prototype.evaluate = evaluate;
    }
    const captured = await prisma.browserSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    const saved = await readBrowserCheckpoint(userId, captured.checkpointRef!);
    assert.equal(saved.tabs.length, 1);
    assert.equal(saved.tabs[0]!.frames!.length, 3);
    assert(
      saved.tabs[0]!.frames!.find((frame) => frame.origin === frameOrigin)?.sessionStorage.some(
        (entry) => entry.name === 'unobserved-session' && entry.value === 'preserve-me'
      )
    );
    const lateSaved = saved.tabs[0]!.frames!.find((frame) => frame.origin === lateOrigin);
    assert(lateSaved, 'a newly observed detached origin must be captured by the existing fallback');
    assert(
      lateSaved.sessionStorage.some(
        (entry) => entry.name === 'late-session' && entry.value === 'retained'
      )
    );
    assert(
      lateSaved.localStorage?.some(
        (entry) => entry.name === 'late-local' && entry.value === 'retained'
      )
    );
    assert(lateSaved.indexedDB, 'detachment must not silently omit IndexedDB');
    const earlySaved = saved.tabs[0]!.frames!.find((frame) => frame.origin === earlyOrigin);
    assert(
      earlySaved,
      'a origin confirmed before its first storage read must be captured by the existing fallback'
    );
    assert(
      earlySaved.sessionStorage.some(
        (entry) => entry.name === 'early-session' && entry.value === 'retained'
      )
    );
    assert(
      earlySaved.localStorage?.some(
        (entry) => entry.name === 'early-local' && entry.value === 'retained'
      )
    );
    assert(earlySaved.indexedDB, 'detachment must not silently omit IndexedDB');
    assert(
      saved.storage.origins.some((origin) =>
        origin.localStorage.some((entry) => entry.name === 'cart' && entry.value === 'one')
      )
    );
    // The real capture opens and detaches a separate CDP client. Read source
    // state through a fresh client rather than a stale Playwright projection.
    const verification = await chromium.connectOverCDP(native.endpoint);
    connections.push(verification);
    const restored = await verification.newContext();
    try {
      await restoreLogicalBrowserCheckpoint(row.id, {
        contexts: () => [restored],
      } as Browser);
      assert.equal(await restored.pages()[0]!.evaluate(() => localStorage.getItem('cart')), 'one');
      assert.equal(
        await restored.pages()[0]!.evaluate(() => sessionStorage.getItem('approval')),
        'held'
      );
      const restoredPage = restored.pages()[0]!;
      await restoredPage.evaluate(async (lateOrigin) => {
        await new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = `${lateOrigin}/verify-restored`;
          frame.onload = () => resolve();
          document.body.append(frame);
        });
      }, lateOrigin);
      const restoredLate = restoredPage
        .frames()
        .find((frame) => frame.url() === `${lateOrigin}/verify-restored`);
      assert(restoredLate);
      assert.deepEqual(
        await restoredLate.evaluate(async () => {
          const indexed = await new Promise<unknown>((resolve, reject) => {
            const request = indexedDB.open('late-state');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const result = db.transaction('cart').objectStore('cart').get('value');
              result.onerror = () => reject(result.error);
              result.onsuccess = () => {
                db.close();
                resolve(result.result);
              };
            };
          });
          return [
            sessionStorage.getItem('late-session'),
            localStorage.getItem('late-local'),
            indexed,
          ];
        }),
        ['retained', 'retained', 'retained']
      );
      await restoredPage.evaluate(async (earlyOrigin) => {
        await new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = `${earlyOrigin}/verify-restored`;
          frame.onload = () => resolve();
          document.body.append(frame);
        });
      }, earlyOrigin);
      const restoredEarly = restoredPage
        .frames()
        .find((frame) => frame.url() === `${earlyOrigin}/verify-restored`);
      assert(restoredEarly);
      assert.deepEqual(
        await restoredEarly.evaluate(async () => {
          const indexed = await new Promise<unknown>((resolve, reject) => {
            const request = indexedDB.open('early-state');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const result = db.transaction('cart').objectStore('cart').get('value');
              result.onerror = () => reject(result.error);
              result.onsuccess = () => {
                db.close();
                resolve(result.result);
              };
            };
          });
          return [
            sessionStorage.getItem('early-session'),
            localStorage.getItem('early-local'),
            indexed,
          ];
        }),
        ['retained', 'retained', 'retained']
      );
    } finally {
      await restored.close();
    }
    const livePage = verification
      .contexts()[0]!
      .pages()
      .find((page) => page.url() === row.currentUrl);
    assert(livePage);
    await livePage.evaluate(async (frameOrigin) => {
      await new Promise<void>((resolve) => {
        const frame = document.createElement('iframe');
        frame.src = `${frameOrigin}/eligible`;
        frame.onload = () => resolve();
        document.body.append(frame);
      });
    }, frameOrigin);
    const eligible = livePage.frames().find((frame) => frame.url() === `${frameOrigin}/eligible`);
    assert(eligible);
    await eligible.evaluate(() =>
      Object.defineProperty(globalThis, 'localStorage', {
        get() {
          throw new DOMException('fixture storage read failure', 'SecurityError');
        },
      })
    );
    await assert.rejects(capture(), /fixture storage read failure/);
    const retained = await prisma.browserSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(retained.checkpointRevision, captured.checkpointRevision);
    assert.equal(retained.checkpointRef, captured.checkpointRef);
    assert.equal(retained.sessionId, row.sessionId);
    assert.equal(retained.status, 'ACTIVE');
    const retainedSource = await chromium.connectOverCDP(native.endpoint);
    connections.push(retainedSource);
    assert.equal(retainedSource.isConnected(), true);
    const retainedPage = retainedSource
      .contexts()[0]!
      .pages()
      .find((page) => page.url() === row.currentUrl);
    assert(retainedPage);
    assert.equal(await retainedPage.evaluate(() => localStorage.getItem('cart')), 'one');
    console.log(
      'PASS opaque sandbox skipped; real CDP encrypted restore; eligible read failure retains source'
    );
  } finally {
    try {
      try {
        await Promise.all(connections.map((connection) => connection.close()));
      } finally {
        await browser?.close();
      }
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            )
        )
      );
      try {
        if (taskId)
          await prisma.toolSideEffect.deleteMany({
            where: {
              OR: [
                { operationKey: `steel-browser-task-lifecycle:${taskId}` },
                { request: { path: ['taskId'], equals: taskId } },
              ],
            },
          });
        if (contextId) await prisma.browserContext.delete({ where: { id: contextId } });
        await prisma.user.deleteMany({ where: { userId } });
      } finally {
        for (const [key, value] of Object.entries(environment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
