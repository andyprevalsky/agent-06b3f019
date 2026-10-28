/** Real CDP/DB/encrypted checkpoint regression for opaque iframe origins. */
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
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
    await capture();
    const captured = await prisma.browserSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    const saved = await readBrowserCheckpoint(userId, captured.checkpointRef!);
    assert.equal(saved.tabs.length, 1);
    assert.equal(saved.tabs[0]!.frames!.length, 0);
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
