/** Local E2E server: real activity HTTP, Prisma, encrypted checkpoints and CDP.
 * Only the paid native-provider allocation/release boundary is substituted.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import { chromium, type Browser } from 'playwright';
import {
  TestChildProcesses,
  withTestDeadline,
  type OwnedTestChild,
} from './browser-session-e2e-process.support';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
async function main() {
  const readyPath = process.argv[2];
  assert.ok(readyPath, 'ready manifest path is required');
  const baseUrl = new URL(
    process.env.BROWSER_PAUSE_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? ''
  );
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname),
    'E2E requires local Postgres'
  );
  const database = `browser_pause_e2e_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'browser-pause-real-'));
  const admin = new PrismaClient({ datasourceUrl: baseUrl.toString() });
  const children = new TestChildProcesses();
  const httpServers: Server[] = [];
  let databaseCreated = false;
  let fixturePrisma: PrismaClient | undefined;
  let cleanupPromise: Promise<void> | undefined;
  function cleanup(): Promise<void> {
    return (cleanupPromise ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => children.stopAll());
      for (const server of httpServers) {
        await attempt(() =>
          withTestDeadline(
            new Promise<void>((done, reject) => {
              server.close((error) => (error ? reject(error) : done()));
              server.closeAllConnections();
            }),
            2000,
            'E2E HTTP server shutdown'
          )
        );
      }
      if (fixturePrisma) await attempt(() => fixturePrisma!.$disconnect());
      if (databaseCreated)
        await attempt(async () => {
          await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
          databaseCreated = false;
        });
      await attempt(() => admin.$disconnect());
      if (!errors.length) await attempt(() => rm(directory, { recursive: true, force: true }));
      if (errors.length) throw new AggregateError(errors, 'E2E fixture cleanup failed');
    })());
  }
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    baseUrl.pathname = `/${database}`;
    baseUrl.searchParams.set('schema', 'public');
    process.env.DATABASE_URL = baseUrl.toString();
    process.env.DIRECT_URL = baseUrl.toString();
    process.env.BACKEND_API_KEY = `e2e-${randomUUID()}`;
    process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
    process.env.CODE_SESSION_STORAGE_LOCAL_DIR = join(directory, 'checkpoints');
    const fixtureKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
      fixtureKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ).toString('base64');
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    await run(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 120_000,
        maxBuffer: 2_000_000,
      }
    );
    const { prisma } =
      require('../../providers/database') as typeof import('../../providers/database');
    fixturePrisma = prisma;
    type Native = {
      id: string;
      owned: OwnedTestChild;
      endpoint: string;
      browser: Browser;
      alive: boolean;
    };
    const natives = new Map<string, Native>();
    let active: Native | undefined;
    let generation = 0;
    let releases = 0;
    let orders = 0;
    let merchant = '';
    let frameOrigin = '';
    let lastStorage: Record<string, unknown> = {};

    async function allocate(): Promise<Native> {
      const id = `e2e-native-${++generation}`;
      const profile = join(directory, id);
      return children.acquire(
        chromium.executablePath(),
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
        async (owned) => {
          const child = owned.child;
          const endpoint = await new Promise<string>((done, reject) => {
            let output = '';
            const timer = setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error(`Chromium CDP readiness failed: ${output.slice(-2000)}`));
            }, 15_000);
            child.stderr!.on('data', (data) => {
              output += data.toString();
              const address = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
              if (address) {
                clearTimeout(timer);
                done(address);
              }
            });
            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once('exit', (code, signal) => {
              clearTimeout(timer);
              reject(new Error(`Chromium exited ${code ?? signal}: ${output.slice(-2000)}`));
            });
          });
          const browser = await withTestDeadline(
            chromium.connectOverCDP(endpoint),
            15_000,
            'Chromium CDP connect'
          );
          const native = { id, owned, endpoint, browser, alive: true };
          natives.set(id, native);
          return native;
        }
      );
    }

    async function retire(native: Native | undefined) {
      if (!native?.alive) return;
      // End the exact owned browser, not merely its CDP client connection.
      await native.owned.stop();
      native.alive = false;
      await withTestDeadline(native.browser.close(), 2000, 'Chromium CDP detach');
    }

    async function storage() {
      if (!active?.alive) return lastStorage;
      const context = active.browser.contexts()[0]!;
      const page = context.pages().find((candidate) => candidate.url().startsWith(merchant))!;
      if (!page) return {};
      lastStorage = await page.evaluate(async () => {
        const indexedDBValue = await new Promise<unknown>((done, reject) => {
          const open = indexedDB.open('checkout', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('cart')) {
              db.close();
              done(null);
              return;
            }
            const tx = db.transaction('cart');
            const read = tx.objectStore('cart').get('current');
            read.onsuccess = () => done(read.result ?? null);
            read.onerror = () => reject(read.error);
            tx.oncomplete = () => db.close();
          };
        });
        return {
          cookie: document.cookie,
          localStorage: localStorage.getItem('cart'),
          indexedDB: indexedDBValue,
          sessionStorage: sessionStorage.getItem('checkout'),
          url: location.href,
          cart: document.querySelector('#cart')?.textContent,
        };
      });
      await page.frameLocator('iframe[title="Shipping checkout"]').locator('h1').waitFor();
      const frameState = await Promise.all(
        page
          .frames()
          .filter((frame) => frame !== page.mainFrame() && /^https?:/.test(frame.url()))
          .map((frame) =>
            frame.evaluate(async () => {
              const indexedDBValue = await new Promise<unknown>((done, reject) => {
                const open = indexedDB.open('checkout', 1);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                  const db = open.result;
                  if (!db.objectStoreNames.contains('cart')) {
                    db.close();
                    done(null);
                    return;
                  }
                  const tx = db.transaction('cart');
                  const read = tx.objectStore('cart').get('current');
                  read.onsuccess = () => done(read.result ?? null);
                  read.onerror = () => reject(read.error);
                  tx.oncomplete = () => db.close();
                };
              });
              return {
                origin: location.origin,
                url: location.href,
                localStorage: Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)),
                indexedDB: indexedDBValue,
                sessionStorage: Object.entries(sessionStorage).sort(([a], [b]) =>
                  a.localeCompare(b)
                ),
              };
            })
          )
      );
      frameState.sort((a, b) => a.origin.localeCompare(b.origin) || a.url.localeCompare(b.url));
      lastStorage = { ...lastStorage, frameState };
      return lastStorage;
    }

    const loader = Module as unknown as {
      _load: (id: string, parent: { filename?: string }, main: boolean) => unknown;
    };
    const original = loader._load;
    const providerIndex = resolve('src/providers/browser/index.ts');
    loader._load = function (id, parent, main) {
      // Configure only the fixture's credential key. Encryption/decryption and
      // the checkpoint store execute unchanged, with no production private key.
      if (
        parent?.filename === resolve('src/providers/credentialEnvelope.ts') &&
        id === './encryptionKeys'
      ) {
        return {
          RSA_PUBLIC_KEY_PEM: fixtureKeys.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        };
      }
      const actual = original.call(this, id, parent, main);
      if (parent?.filename !== providerIndex || id !== './kernel') return actual;
      return {
        ...(actual as object),
        getKernelSessionHealth: async (id: string) => ({
          provider: 'kernel',
          sessionId: id,
          status: natives.get(id)?.alive ? 'active' : 'stopped',
          ttlMs: natives.get(id)?.alive ? 900_000 : 0,
        }),
        closeKernelSession: async (id: string) => {
          const row = await prisma.browserSession.findUniqueOrThrow({ where: { sessionId: id } });
          assert.ok(row.checkpointRef, 'provider release must follow durable checkpoint');
          await storage();
          await retire(natives.get(id));
          releases++;
          await prisma.browserSession.update({ where: { id: row.id }, data: { status: 'CLOSED' } });
        },
        resumeKernelSession: async (taskId: string) => {
          const { browserResumeScope, resumeNativeCreate } =
            require('../../providers/steel/lifecycleClaim') as typeof import('../../providers/steel/lifecycleClaim');
          const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
          await browserResumeScope()?.beforeCreate('kernel');
          const next = await resumeNativeCreate(allocate);
          active = next;
          const changed = await prisma.browserSession.updateMany({
            where: { id: taskId, sessionId: row.sessionId, status: row.status },
            data: {
              sessionId: next.id,
              wsUrl: next.endpoint,
              debugUrl: merchant,
              status: 'PAUSED',
              closedAt: null,
            },
          });
          assert.equal(changed.count, 1);
          await retire(natives.get(row.sessionId ?? ''));
          return {
            provider: 'kernel',
            sessionId: next.id,
            wsUrl: next.endpoint,
            debugUrl: merchant,
            savedUrl: row.currentUrl ?? row.startUrl,
            proxySource: 'kernel_mobile_city',
            proxyLocation: { city: 'san_francisco', state: 'CA', country: 'US' },
            profileId: null,
            profileSource: 'challenge_candidate_ephemeral',
            validationBrowser: await chromium.connectOverCDP(next.endpoint),
          };
        },
      };
    };

    const app = express();
    app.use(express.json());
    app.get('/checkout', (_req, res) =>
      res
        .type('html')
        .send(
          `<body><div id="cart">patches:1</div><button id="order">Place Order</button><iframe title="Shipping checkout" src="${frameOrigin}/details"></iframe></body>`
        )
    );
    app.post('/order', (req, res) => {
      if (!req.headers.cookie?.includes('session=signed-in')) {
        res.status(401).json({ error: 'login required' });
        return;
      }
      orders++;
      res.json({ receipt: `fixture-order-${orders}`, success: true });
    });
    const routes = require('../../domains/browser-session/routes').default;
    app.use('/api/browser-session', routes);
    app.use('/api/auth-options', require('../../domains/auth-options/routes').default);

    async function setup(mode: string) {
      for (const native of natives.values()) await retire(native);
      releases = 0;
      orders = 0;
      lastStorage = {};
      await prisma.toolSideEffect.deleteMany({
        where: {
          operationKey: 'steel-browser-task-lifecycle:11111111-1111-4111-8111-111111111111',
        },
      });
      await prisma.browserSession.deleteMany();
      await prisma.browserContext.deleteMany();
      await prisma.agent.deleteMany();
      await prisma.user.deleteMany();
      process.env.CODE_SESSION_STORAGE_LOCAL_DIR = join(directory, 'checkpoints');
      if (mode === 'capture_failure') {
        const blocked = join(directory, 'not-a-directory');
        await writeFile(blocked, 'fixture-owned write failure');
        process.env.CODE_SESSION_STORAGE_LOCAL_DIR = blocked;
      }
      await prisma.user.create({ data: { userId: 'u1', isAnonymous: true } });
      await prisma.agent.create({
        data: { id: 'a1', userId: 'u1', goal: 'Local browser approval E2E', status: 'ACTIVE' },
      });
      const context = await prisma.browserContext.create({ data: { userId: 'u1' } });
      active = await allocate();
      const page = active.browser.contexts()[0]!.pages()[0]!;
      await page.goto(`${merchant}/checkout`);
      await page.evaluate(async () => {
        document.cookie = 'session=signed-in; path=/';
        localStorage.setItem('cart', 'patches:1');
        sessionStorage.setItem('checkout', 'approved-checkout');
        await new Promise<void>((done, reject) => {
          const open = indexedDB.open('checkout', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('cart');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('cart', 'readwrite');
            tx.objectStore('cart').put('patches:1', 'current');
            tx.oncomplete = () => {
              db.close();
              done();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      });
      const checkoutFrame = page.frames().find((frame) => frame.url() === `${frameOrigin}/details`);
      assert.ok(checkoutFrame, 'same-site cross-origin checkout frame must be loaded');
      await checkoutFrame.evaluate(async () => {
        localStorage.setItem('cart', 'frame:shipping');
        sessionStorage.setItem('checkout', 'frame-checkout-approved');
        await new Promise<void>((done, reject) => {
          const open = indexedDB.open('checkout', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('cart');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('cart', 'readwrite');
            tx.objectStore('cart').put('frame:shipping', 'current');
            tx.oncomplete = () => {
              db.close();
              done();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      });
      await prisma.browserSession.create({
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          agentId: 'a1',
          contextId: context.id,
          sessionId: active.id,
          provider: 'kernel',
          wsUrl: active.endpoint,
          debugUrl: merchant,
          logicalOwnerKey: 'agent:a1',
          status: 'ACTIVE',
          baselineCheckpointRef: 'browser-checkpoint:empty:v1',
          startUrl: `${merchant}/checkout`,
          currentUrl: `${merchant}/checkout`,
          providerProfileSource: 'challenge_candidate_ephemeral',
          providerProfilePersist: false,
        },
      });
      return require('../../domains/browser-session/service.task-info').getTaskInfo(
        '11111111-1111-4111-8111-111111111111',
        {
          validateLive: true,
        }
      );
    }
    app.post('/__test/setup', (req, res, next) => {
      void setup(req.body.mode ?? 'normal').then((data) => res.json(data), next);
    });
    app.post('/__test/state', (_req, res, next) => {
      void (async () => {
        const row = await prisma.browserSession.findUniqueOrThrow({
          where: { id: '11111111-1111-4111-8111-111111111111' },
        });
        const checkpoint = row.checkpointRef
          ? await require('../../providers/browser/checkpoint').readBrowserCheckpoint(
              'u1',
              row.checkpointRef
            )
          : null;
        res.json({
          ...(await storage()),
          checkpoint,
          task_id: row.id,
          native_id: row.sessionId,
          checkpointRevision: row.checkpointRevision,
          status: row.status,
          alive: active?.alive ?? false,
          releaseCount: releases,
          orderCount: orders,
        });
      })().catch(next);
    });
    app.post('/__test/expire', (_req, res, next) => {
      void retire(active).then(() => res.json({ success: true }), next);
    });
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        console.error(error);
        res.status(500).json({ error: error.message });
      }
    );
    const frameApp = express();
    frameApp.get('/details', (_req, res) =>
      res
        .type('html')
        .send(
          '<body><h1>Shipping checkout</h1><p>One canvas tote. Shipping destination: United States.</p></body>'
        )
    );
    const frameServer = await new Promise<ReturnType<typeof frameApp.listen>>((done) => {
      const listening = frameApp.listen(0, '127.0.0.1', () => done(listening));
    });
    httpServers.push(frameServer);
    const frameAddress = frameServer.address();
    assert.ok(frameAddress && typeof frameAddress !== 'string');
    frameOrigin = `http://127.0.0.1:${frameAddress.port}`;
    const server = await new Promise<ReturnType<typeof app.listen>>((done) => {
      const listening = app.listen(0, '127.0.0.1', () => done(listening));
    });
    httpServers.push(server);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    merchant = `http://127.0.0.1:${address.port}`;
    app.post('/__test/shutdown', (_req, res) => {
      res.json({ success: true });
      void cleanup().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        }
      );
    });
    process.once('SIGTERM', () => {
      void cleanup().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        }
      );
    });
    await setup('normal');
    await writeFile(
      readyPath,
      JSON.stringify({
        api_url: merchant,
        merchant_url: `${merchant}/checkout`,
        task_id: '11111111-1111-4111-8111-111111111111',
        api_key: process.env.BACKEND_API_KEY,
        fixture_decryption_key: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
      })
    );
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'E2E startup and cleanup failed');
    }
    throw error;
  }
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
