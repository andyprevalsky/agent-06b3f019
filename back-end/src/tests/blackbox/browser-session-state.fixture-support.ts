import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright';
import type { BrowserCheckpoint } from '../../providers/browser/checkpoint';
const local = createRequire(import.meta.url);
const FRAME_URL = 'https://frame.lifecycle.invalid/state';
const DB_ONLY_FRAME_URL = 'https://database.lifecycle.invalid/state';

export async function captureLifecycleCheckpoint(taskId: string, nativeId: string) {
  const { checkpointLogicalBrowser } = local(
    '../../providers/browser/checkpoint'
  ) as typeof import('../../providers/browser/checkpoint');
  const { withSteelLifecycleClaim } = local(
    '../../providers/steel/lifecycleClaim'
  ) as typeof import('../../providers/steel/lifecycleClaim');
  const { prisma } = local('../../providers/database') as typeof import('../../providers/database');
  await withSteelLifecycleClaim(taskId, async (_assert, _native, mutate) =>
    checkpointLogicalBrowser(nativeId, mutate)
  );
  const saved = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  return { task_id: taskId, session_id: nativeId, checkpoint_revision: saved.checkpointRevision };
}

export async function selectLifecycleCheckpointFormat(
  checkpoint: BrowserCheckpoint,
  cycle: number,
  taskId: string
) {
  const { writeBrowserCheckpoint } = local(
    '../../providers/browser/checkpoint'
  ) as typeof import('../../providers/browser/checkpoint');
  const { prisma } = local('../../providers/database') as typeof import('../../providers/database');
  for (const tab of checkpoint.tabs) {
    if (cycle === 0) tab.sessionStorage = tab.sessionStorage.filter((entry) => !entry.origin);
    else for (const frame of tab.frames ?? []) frame.sessionStorage = [];
  }
  const checkpointRef = await writeBrowserCheckpoint(checkpoint);
  await prisma.browserSession.update({ where: { id: taskId }, data: { checkpointRef } });
}

export function assertLifecycleCheckpointAvailable(operation: unknown) {
  assert.equal(
    typeof operation,
    'function',
    'parked provider requires a checkpoint-only owner operation'
  );
}

export function assertLifecycleCheckpointReceipt(
  receipt: { task_id: string; session_id: string; checkpoint_revision: number },
  taskId: string,
  sessionId: string
) {
  assert.equal(receipt.task_id, taskId);
  assert.equal(receipt.session_id, sessionId);
  assert(receipt.checkpoint_revision > 0);
}
async function lifecycleFrame(page: Page, frameUrl = FRAME_URL) {
  await page.route(frameUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
  );
  await page.evaluate(async (url) => {
    await new Promise<void>((resolve) => {
      const frame = document.createElement('iframe');
      frame.onload = () => resolve();
      frame.src = url;
      document.body.append(frame);
    });
  }, frameUrl);
  const frame = page.frames().find((frame) => frame.url() === frameUrl);
  assert(frame, 'lifecycle cross-origin frame exists');
  return frame;
}

export const lifecycleUrls = (origin: string) =>
  [`${origin}/?lifecycle=one`, `${origin}/?lifecycle=two`] as const;
export async function populateLifecycleState(browser: Browser, origin: string) {
  const [one, two] = lifecycleUrls(origin);
  const context = browser.contexts()[0];
  assert(context);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(one);
  await page.evaluate(async () => {
    document.cookie = 'contract=cookie; path=/';
    localStorage.setItem('contract', 'local');
    sessionStorage.setItem('contract', 'session');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('contract', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('values');
        if (request.result.name === 'frame-contract') {
          request.result.createObjectStore('auto', { autoIncrement: true });
          const typed = request.result.createObjectStore('typed', { keyPath: ['kind', 'id'] });
          typed.createIndex('tag', 'tag', { unique: true });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction('values', 'readwrite');
        tx.objectStore('values').put('indexed', 'key');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  const second = await context.newPage();
  await second.goto(two);
  await second.evaluate(() => sessionStorage.setItem('tab', 'two'));
  for (const [tab, value] of [
    [page, 'frame-one'],
    [second, 'frame-two'],
  ] as const) {
    const frame = await lifecycleFrame(tab);
    await frame.evaluate((value) => {
      localStorage.setItem('frame-local', 'retained');
      sessionStorage.setItem('frame-session', value);
    }, value);
    await frame.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('frame-contract', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('values');
          if (request.result.name === 'frame-contract') {
            request.result.createObjectStore('auto', { autoIncrement: true });
            const typed = request.result.createObjectStore('typed', { keyPath: ['kind', 'id'] });
            typed.createIndex('tag', 'tag', { unique: true });
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(['values', 'typed', 'auto'], 'readwrite');
          tx.objectStore('values').put('frame-indexed', 'key');
          const cycle: { self?: unknown } = {};
          cycle.self = cycle;
          const sparse: unknown[] & { extra?: string } = Array(3);
          sparse[2] = undefined;
          sparse.extra = 'kept';
          tx.objectStore('typed').put({
            kind: 'record',
            id: 7,
            tag: 'unique',
            date: new Date('2026-10-26T00:00:00Z'),
            bytes: new Uint8Array([1, 2, 255]),
            sparse,
            map: new Map([['key', new Set([1, 2])]]),
            cycle,
            positiveZero: 0,
            zero: -0,
            blob: new Blob(['checkpoint'], { type: 'text/plain' }),
          });
          tx.objectStore('auto').put('discarded', 42);
          tx.objectStore('auto').delete(42);
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
    await frame.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('values');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction('values', 'readwrite');
          tx.objectStore('values').put('empty-name', 'key');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    });
    const databaseOnly = await lifecycleFrame(tab, DB_ONLY_FRAME_URL);
    await databaseOnly.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('frame-only-contract', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('values');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction('values', 'readwrite');
          tx.objectStore('values').put('database-only', 'key');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    });
  }
}
export async function assertLifecycleState(browser: Browser, origin: string) {
  const [one, two] = lifecycleUrls(origin);
  const tabs = browser.contexts()[0]!.pages();
  const restored = tabs.find((p) => p.url() === one);
  assert(restored, 'first tab URL restored');
  assert.deepEqual(
    await restored.evaluate(async () => ({
      cookie: document.cookie,
      local: localStorage.getItem('contract'),
      session: sessionStorage.getItem('contract'),
      indexed: await new Promise((resolve, reject) => {
        const r = indexedDB.open('contract', 1);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('checkpoint IndexedDB open blocked'));
        r.onupgradeneeded = () => {
          r.transaction?.abort();
          reject(new Error('checkpoint IndexedDB database missing'));
        };
        r.onsuccess = () => {
          const d = r.result;
          try {
            const t = d.transaction('values', 'readonly'),
              q = t.objectStore('values').get('key');
            q.onerror = () => {
              d.close();
              reject(q.error);
            };
            q.onsuccess = () => {
              d.close();
              resolve(q.result);
            };
          } catch (error) {
            d.close();
            reject(error);
          }
        };
      }),
    })),
    { cookie: 'contract=cookie', local: 'local', session: 'session', indexed: 'indexed' }
  );
  const tab2 = tabs.find((p) => p.url() === two);
  assert(tab2);
  assert.equal(await tab2.evaluate(() => sessionStorage.getItem('tab')), 'two');
  for (const [tab, value] of [
    [restored, 'frame-one'],
    [tab2, 'frame-two'],
  ] as const) {
    const frame = await lifecycleFrame(tab);
    assert.deepEqual(
      await frame.evaluate(() => ({
        local: localStorage.getItem('frame-local'),
        session: sessionStorage.getItem('frame-session'),
      })),
      { local: 'retained', session: value },
      'cross-origin sessionStorage preserves each top-level tab namespace'
    );
    assert.equal(
      await frame.evaluate(async () => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('frame-contract', 1);
          request.onupgradeneeded = () => {
            request.transaction?.abort();
            reject(new Error('partitioned frame IndexedDB database missing'));
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction('values', 'readonly');
            const get = tx.objectStore('values').get('key');
            get.onsuccess = () => {
              db.close();
              resolve(get.result);
            };
            get.onerror = () => {
              db.close();
              reject(get.error);
            };
          };
        });
      }),
      'frame-indexed',
      'partitioned frame IndexedDB survives native replacement'
    );
    assert.deepEqual(
      await frame.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('frame-contract');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const tx = db.transaction('typed', 'readonly'),
            store = tx.objectStore('typed');
          const value = await new Promise<{
            date: Date;
            bytes: Uint8Array;
            map: Map<string, Set<number>>;
            cycle: { self?: unknown };
            zero: number;
            sparse: unknown[] & { extra?: string };
            blob: Blob;
          }>((resolve, reject) => {
            const request = store.index('tag').get('unique');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return {
            keyPath: store.keyPath,
            index: store.index('tag').unique,
            date: value.date.toISOString(),
            bytes: [...value.bytes],
            map: [...value.map.get('key')],
            cycle: value.cycle.self === value.cycle,
            negativeZero: Object.is(value.zero, -0),
            blob: await value.blob.text(),
            sparse: [0 in value.sparse, 2 in value.sparse],
            extra: value.sparse.extra,
          };
        } finally {
          db.close();
        }
      }),
      {
        keyPath: ['kind', 'id'],
        index: true,
        date: '2026-10-26T00:00:00.000Z',
        bytes: [1, 2, 255],
        map: [1, 2],
        cycle: true,
        negativeZero: true,
        blob: 'checkpoint',
        sparse: [false, true],
        extra: 'kept',
      }
    );
    assert.equal(
      await frame.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('frame-contract');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const tx = db.transaction('auto', 'readwrite'),
              request = tx.objectStore('auto').add('probe');
            let key: IDBValidKey;
            request.onsuccess = () => {
              key = request.result;
              tx.abort();
            };
            request.onerror = () => reject(request.error);
            tx.onabort = () => resolve(key);
          });
        } finally {
          db.close();
        }
      }),
      43,
      'deleted high keys still advance the restored auto-increment generator'
    );
    assert.equal(
      await frame.evaluate(async () => {
        return await new Promise((resolve, reject) => {
          const r = indexedDB.open('', 1);
          r.onupgradeneeded = () => {
            r.transaction?.abort();
            reject(new Error('empty-name frame database missing'));
          };
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result,
              request = db.transaction('values', 'readonly').objectStore('values').get('key');
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
          };
        });
      }),
      'empty-name',
      'valid empty IndexedDB database names survive restoration'
    );
    const databaseOnly = await lifecycleFrame(tab, DB_ONLY_FRAME_URL);
    assert.equal(
      await databaseOnly.evaluate(async () => {
        return await new Promise((resolve, reject) => {
          const r = indexedDB.open('frame-only-contract', 1);
          r.onupgradeneeded = () => {
            r.transaction?.abort();
            reject(new Error('unloaded database-only frame checkpoint missing'));
          };
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result,
              request = db.transaction('values', 'readonly').objectStore('values').get('key');
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
          };
        });
      }),
      'database-only',
      'unloaded origins containing only IndexedDB remain in the checkpoint'
    );
  }
}

/** Insert another same-parent popup immediately before the private clone is opened. */
export function raceLifecycleCheckpointPopup(browser: Browser, failCapture = false) {
  const context = browser.contexts()[0]!;
  const source = context.pages().find((page) => /^https?:/.test(page.url()))!;
  const foreignUrl = `about:blank#fixture-unrelated-${randomUUID()}`;
  const openSession = context.newCDPSession.bind(context);
  let foreign: Page | undefined;
  context.newCDPSession = async (page) => {
    const cdp = await openSession(page);
    if (failCapture && 'opener' in page && page !== foreign && (await page.opener()) === source) {
      await cdp.detach();
      throw new Error('fixture capture preparation failed');
    }
    if (page !== source) return cdp;
    return new Proxy(cdp, {
      get(target, key) {
        if (key === 'send')
          return async (method: string, params: Record<string, unknown>) => {
            if (
              method === 'Runtime.evaluate' &&
              typeof params.expression === 'string' &&
              params.expression.includes('window.open') &&
              !foreign
            ) {
              const opened = source.waitForEvent('popup', { timeout: 10_000 });
              await target.send('Runtime.evaluate', {
                expression: `window.open(${JSON.stringify(foreignUrl)}, '_blank')`,
                userGesture: true,
              });
              foreign = await opened;
            }
            return Reflect.apply(target.send, target, [method, params]);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { foreignUrl, foreign: () => foreign };
}

/** Verify remote target custody, not the closed/disconnected state of a CDP projection. */
export async function assertLifecyclePopupIsolation(
  browser: Browser,
  origin: string,
  control: {
    enabled: boolean;
    fail: boolean;
    probe?: ReturnType<typeof raceLifecycleCheckpointPopup>;
  },
  capture: () => Promise<unknown>
) {
  for (const page of browser.contexts()[0]!.pages())
    await page.evaluate('document.querySelectorAll("iframe").forEach(frame => frame.remove())');
  for (const fail of [false, true]) {
    Object.assign(control, { enabled: true, fail });
    try {
      if (fail) await assert.rejects(capture(), /fixture capture preparation failed/);
      else await capture();
      assert(control.probe?.foreign(), 'competing popup was inserted at clone creation');
      const cdp = await browser.newBrowserCDPSession();
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const pages = targetInfos.filter((target) => target.type === 'page');
        const foreign = pages.find((target) => target.url === control.probe!.foreignUrl);
        assert(foreign, 'checkpoint must preserve an unrelated popup');
        assert.deepEqual(
          pages.map((page) => page.url).sort(),
          [...lifecycleUrls(origin), control.probe.foreignUrl].sort(),
          'capture closes its own exact clone'
        );
        assert((await cdp.send('Target.closeTarget', { targetId: foreign.targetId })).success);
      } finally {
        await cdp.detach();
      }
    } finally {
      Object.assign(control, { enabled: false, fail: false, probe: undefined });
    }
  }
}

export const createLifecyclePopupRace = () => ({
  enabled: false,
  fail: false,
  probe: undefined as ReturnType<typeof raceLifecycleCheckpointPopup> | undefined,
});

export async function connectLifecycleCheckpointBrowser(
  id: string,
  endpoints: Map<string, string>,
  race: ReturnType<typeof createLifecyclePopupRace>
) {
  const endpoint = endpoints.get(id) ?? [...endpoints.values()].find((value) => value === id);
  if (!endpoint) return null;
  const browser = await chromium.connectOverCDP(endpoint);
  if (race.enabled) race.probe = raceLifecycleCheckpointPopup(browser, race.fail);
  return browser;
}

export function assertLifecycleFrameCheckpoint(initialCheckpoint: BrowserCheckpoint) {
  assert.deepEqual(
    initialCheckpoint.tabs
      .sort((a, b) => a.url.localeCompare(b.url))
      .map((tab) => tab.frames?.flatMap((frame) => frame.sessionStorage)),
    [
      [{ name: 'frame-session', value: 'frame-one' }],
      [{ name: 'frame-session', value: 'frame-two' }],
    ],
    'fresh CDP capture waits for cross-site frame attachment before publishing state'
  );
  assert.deepEqual(
    initialCheckpoint.tabs.flatMap((tab) =>
      tab.frames
        ?.filter((frame) => frame.origin === new URL(FRAME_URL).origin)
        .map((frame) => ('localStorage' in frame ? frame.localStorage : undefined))
    ),
    [[{ name: 'frame-local', value: 'retained' }], [{ name: 'frame-local', value: 'retained' }]],
    'checkpoint retains third-party localStorage in each top-level site partition'
  );
}

type ResumeHealth = { session_id: string; browser_session_health?: { sessionId?: string } | null };
export function assertLifecycleResumeHealth(a: ResumeHealth, b: ResumeHealth) {
  assert.equal(
    a.browser_session_health?.sessionId,
    a.session_id,
    'resume returns actual native health'
  );
  assert.equal(
    b.browser_session_health?.sessionId,
    b.session_id,
    'joined resume returns actual native health'
  );
}
