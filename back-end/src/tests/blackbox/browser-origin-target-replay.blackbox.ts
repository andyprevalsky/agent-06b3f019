#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';
import {
  injectCacheStorageState,
  injectIndexedDBState,
  injectLocalStorageState,
} from '../../providers/steel/injectionState';
import { prisma } from '../../providers/database';
import { createOriginPayloadWriter } from '../../providers/steel/injectionOriginPage';

/** Actual CDP target attachment must not fan out retained credential payloads. */
async function verifyOriginTargetReplay() {
  const marker = 'ORIGIN_REPLAY_FIXTURE:';
  const value = marker.repeat(Math.ceil((2 * 1024 * 1024) / marker.length));
  const directory = await mkdtemp(join(tmpdir(), 'rose-origin-target-replay-'));
  let browser: BrowserContext | undefined;
  let injector: Browser | undefined;
  let relay: WebSocketServer | undefined;
  const connections = new Set<WebSocket>();
  const sessions = new Map<string, { id: string; type: string }>();
  const traffic: Array<{ target: string; bytes: number; payloadBytes: number }> = [];
  let observe = false;
  let originPayloadEvaluations = 0;
  let restoreNetworkRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/.rose-storage-')) restoreNetworkRequests++;
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/read-at-boot') {
      response.end(`<script>
        window.seedAtBoot = new Promise(resolve => {
          const request = indexedDB.open('origin-replay');
          request.onupgradeneeded = () => resolve(null);
          request.onerror = () => resolve(null);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('records')) { db.close(); resolve(null); return; }
            const read = db.transaction('records').objectStore('records').get('payload');
            read.onsuccess = () => resolve(read.result ?? null);
            read.onerror = () => resolve(null);
            db.close();
          };
        });
      </script>`);
    } else if (request.url === '/unrelated') {
      const address = server.address();
      assert(address && typeof address !== 'string');
      response.end(`<iframe src="http://iframe.foreign.test:${address.port}/frame"></iframe>`);
    } else {
      response.end('<body>local fixture</body>');
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launchPersistentContext(directory, {
      headless: true,
      channel: 'chromium',
      args: [
        '--remote-debugging-port=0',
        '--site-per-process',
        '--no-proxy-server',
        '--host-resolver-rules=MAP *.test 127.0.0.1',
      ],
    });
    const [port, socketPath] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split('\n');
    assert.match(port, /^\d+$/);
    assert.match(socketPath, /^\/devtools\/browser\/[a-f0-9-]+$/);
    relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => relay!.once('listening', resolve));
    relay.on('connection', (client) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
      connections.add(client);
      connections.add(upstream);
      const pending: Buffer[] = [];
      client.on('message', (data) => {
        const bytes = Buffer.from(data.toString());
        const message = JSON.parse(bytes.toString());
        if (
          ['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(message.method) &&
          JSON.stringify(message.params).includes('rose.origin-state.')
        ) {
          originPayloadEvaluations++;
        }
        if (observe && message.method === 'Page.addScriptToEvaluateOnNewDocument') {
          const script = String(message.params.source);
          traffic.push({
            target: sessions.get(message.sessionId)?.id ?? 'unmapped',
            bytes: bytes.length,
            payloadBytes: script.includes(marker) ? Buffer.byteLength(script) : 0,
          });
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary: false });
        else pending.push(bytes);
      });
      upstream.on('open', () => {
        for (const data of pending.splice(0)) upstream.send(data, { binary: false });
      });
      upstream.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === 'Target.attachedToTarget') {
          sessions.set(message.params.sessionId, {
            id: message.params.targetInfo.targetId,
            type: message.params.targetInfo.type,
          });
        }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false });
      });
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
    });
    const relayAddress = relay.address();
    assert(relayAddress && typeof relayAddress !== 'string');
    injector = await chromium.connectOverCDP(`ws://127.0.0.1:${relayAddress.port}`);
    const context = injector.contexts()[0];
    assert(context, 'actual default Chromium context is missing');
    const seed = await context.newPage();
    await seed.goto(`${origin}/preseed`);
    await seed.evaluate(async () => {
      localStorage.setItem('untouched', 'existing');
      await caches.open('existing-cache');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('origin-replay', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put('existing', 'sentinel');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    });
    await seed.close();
    const callerPages = context.pages();
    const beforeLocalStorage = originPayloadEvaluations;
    await injectLocalStorageState(
      context,
      [
        {
          origin,
          entries: [
            { key: 'restored', value: 'preserved 🦋' },
            { key: 'empty', value: '' },
          ],
        },
      ],
      Date.now()
    );
    const localStorageMutations = originPayloadEvaluations - beforeLocalStorage;
    assert.ok(localStorageMutations > 0, 'actual CDP payload evaluations were not observed');
    console.log(JSON.stringify({ originPayloadSinglePacketMutations: localStorageMutations }));
    assert.equal(
      localStorageMutations,
      1,
      'fitting origin payload spent a second CDP acknowledgement on completion'
    );
    await injectIndexedDBState(
      context,
      [
        {
          origin,
          databases: [
            {
              name: 'origin-replay',
              objectStores: [{ name: 'records', records: [{ key: 'payload', value }] }],
            },
          ],
        },
      ],
      Date.now()
    );
    await injectCacheStorageState(
      context,
      [{ origin, caches: [{ name: 'restored-cache' }] }],
      Date.now()
    );
    assert.deepEqual(context.pages(), callerPages, 'storage restore changed caller-owned pages');
    assert.equal(restoreNetworkRequests, 0, 'storage restore navigated the real site');
    observe = true;
    const sibling = await context.newPage();
    const pageCdp = await context.newCDPSession(sibling);
    const pageTarget = (await pageCdp.send('Target.getTargetInfo')).targetInfo;
    const payloadBytes = (target: string) =>
      traffic
        .filter((row) => row.target === target)
        .reduce((sum, row) => sum + row.payloadBytes, 0);
    console.log(
      JSON.stringify({
        originTargetReplayReceipt: true,
        fixtureBytes: Buffer.byteLength(value),
        siblingPayloadBytes: payloadBytes(pageTarget.targetId),
      })
    );
    assert.equal(
      payloadBytes(pageTarget.targetId),
      0,
      'large origin data replayed to unrelated page'
    );
    await sibling.goto(`http://page.unrelated.test:${address.port}/unrelated`);
    await sibling.frameLocator('iframe').locator('body').waitFor();
    const frame = sibling.frames().find((entry) => entry !== sibling.mainFrame());
    assert(frame, 'cross-origin iframe is missing');
    const frameCdp = await context.newCDPSession(frame);
    const frameTarget = (await frameCdp.send('Target.getTargetInfo')).targetInfo;
    assert.equal(frameTarget.type, 'iframe', 'fixture did not create an out-of-process iframe');
    assert.notEqual(pageTarget.targetId, frameTarget.targetId);
    await pageCdp.detach();
    await frameCdp.detach();
    observe = false;
    await injector.close();
    injector = undefined;
    const intended = await browser.newPage();
    await intended.goto(`${origin}/read-at-boot`);
    const firstBoot = await intended.evaluate<string | null>('window.seedAtBoot');
    await intended.reload();
    const nextBoot = await intended.evaluate<string | null>('window.seedAtBoot');
    const storage = await intended.evaluate(async () => ({
      untouched: localStorage.getItem('untouched'),
      restored: localStorage.getItem('restored'),
      empty: localStorage.getItem('empty'),
      caches: (await caches.keys()).sort(),
      sentinel: await new Promise((resolve, reject) => {
        const request = indexedDB.open('origin-replay');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('records').objectStore('records').get('sentinel');
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
    }));
    console.log(
      JSON.stringify({
        originTargetReplayReceipt: true,
        fixtureBytes: Buffer.byteLength(value),
        siblingPayloadBytes: payloadBytes(pageTarget.targetId),
        iframePayloadBytes: payloadBytes(frameTarget.targetId),
        totalInitScriptBytes: traffic.reduce((sum, row) => sum + row.bytes, 0),
        unmappedScriptMessages: traffic.filter((row) => row.target === 'unmapped').length,
        outOfProcessIframe: true,
        exactValueAtFirstAppReadAfterDisconnect: firstBoot === value,
        exactValueAtNextAppRead: nextBoot === value,
      })
    );
    assert.equal(traffic.filter((row) => row.target === 'unmapped').length, 0);
    assert.equal(
      payloadBytes(pageTarget.targetId),
      0,
      'large origin data replayed to unrelated page'
    );
    assert.equal(
      payloadBytes(frameTarget.targetId),
      0,
      'large origin data replayed to unrelated iframe'
    );
    assert.ok(
      firstBoot === value,
      'origin state absent at first app read after injector disconnect'
    );
    assert.ok(nextBoot === value, 'origin state changed across subsequent app navigation');
    assert.deepEqual(
      storage,
      {
        untouched: 'existing',
        restored: 'preserved 🦋',
        empty: '',
        caches: ['existing-cache', 'restored-cache'],
        sentinel: 'existing',
      },
      'restore lost existing storage or failed to persist localStorage/CacheStorage'
    );
    // A CDP newPage reply can arrive after the owning phase was cancelled.
    const pagesBeforeAbort = browser.pages();
    let releaseAcquisition!: (page: Page) => void;
    const acquired = new Promise<Page>((resolve) => {
      releaseAcquisition = resolve;
    });
    const abort = new AbortController();
    let lateSetupCalls = 0;
    const writer = createOriginPayloadWriter(
      {
        newPage: () => acquired,
        newCDPSession: async () => {
          lateSetupCalls++;
          throw new Error('cancelled writer entered CDP setup');
        },
      },
      abort.signal
    );
    const cancelledWrite = writer
      .writeOriginScript(origin, 'throw new Error("late mutation")')
      .then(
        () => false,
        () => true
      );
    abort.abort();
    const latePage = await browser.newPage();
    releaseAcquisition(latePage);
    assert.ok(await cancelledWrite, 'cancelled origin write unexpectedly succeeded');
    await writer.close();
    assert.ok(latePage.isClosed(), 'cancelled acquisition leaked its late-owned page');
    assert.equal(lateSetupCalls, 0, 'cancelled acquisition performed later CDP mutations');
    assert.deepEqual(
      browser.pages(),
      pagesBeforeAbort,
      'cancelled acquisition changed caller pages'
    );
  } finally {
    await injector?.close();
    for (const socket of connections) socket.terminate();
    if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

verifyOriginTargetReplay()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
