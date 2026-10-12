#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import type { Browser } from 'playwright';
import { assertLocalDatabase } from './assertLocalDatabase';
import { prisma } from '../../providers/database';
import { injectUserData } from '../../providers/steel/injection';
import { injectOriginPayload } from '../../providers/steel/injectionOriginPayload';
import {
  injectIndexedDBState,
  injectLocalStorageState,
  injectCacheStorageState,
} from '../../providers/steel/injectionState';

assertLocalDatabase();
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const origin = 'https://payload.origin.test';
async function collect(value: unknown) {
  const scripts: string[] = [];
  await injectOriginPayload(
    {
      writeOriginScript: async (_origin, script) => {
        scripts.push(script);
      },
    },
    { origin },
    'IndexedDBOrigin',
    'window.received.push(data);',
    value
  );
  assert(
    scripts.every(
      (s) => Buffer.byteLength(JSON.stringify({ source: s }), 'utf8') + 1024 <= 1024 * 1024
    ),
    'serialized CDP script exceeded 1MB'
  );
  return scripts;
}
function receiver(host = origin) {
  let parses = 0;
  const window = { location: { origin: host }, received: [] as unknown[] };
  const vm = createContext({
    window,
    JSON: {
      parse: (text: string) => {
        parses++;
        return JSON.parse(text);
      },
    },
  });
  return { window, vm, parses: () => parses };
}

async function verifyAssembly() {
  const value = {
    text: '🦋\\\n"<script>\u2028'.repeat(180000),
    nullable: null,
    fields: ['one', 'two'],
  };
  const scripts = await collect(value);
  assert(scripts.length > 3, 'escaping/Unicode fixture did not exercise chunk assembly');
  for (const ordered of [scripts, [...scripts].reverse()]) {
    const r = receiver();
    for (const script of [...ordered, ...ordered]) runInContext(script, r.vm);
    assert(
      r.window.received.length === 1 && r.parses() === 1,
      'reordered/duplicate scripts reapplied the payload'
    );
    assert(
      JSON.stringify(r.window.received[0]) === JSON.stringify(value),
      'Unicode or escaped payload changed'
    );
  }
  const missing = receiver();
  for (const script of scripts.slice(1)) runInContext(script, missing.vm);
  assert(
    missing.parses() === 0 && missing.window.received.length === 0,
    'partial transfer restored truncated state'
  );
  const foreign = receiver('https://evil-payload.origin.test');
  for (const script of scripts) runInContext(script, foreign.vm);
  assert(
    foreign.parses() === 0 && foreign.window.received.length === 0,
    'foreign origin collected credentials'
  );
  assert(
    Object.getOwnPropertySymbols(foreign.window).length === 0,
    'foreign origin retained partial credentials'
  );
  const a = await collect({ version: 'a' }),
    b = await collect({ version: 'b' });
  const mixed = receiver();
  for (const s of [a.at(-1)!, b[0], a[0], b.at(-1)!]) runInContext(s, mixed.vm);
  assert(
    JSON.stringify(mixed.window.received) === JSON.stringify([{ version: 'a' }, { version: 'b' }]),
    'interleaved injections shared an assembler'
  );
  console.log(
    '✅ bounded scripts preserve Unicode, order, duplicates, missing parts, and origin isolation'
  );
}

async function verifyReceivers() {
  const scripts: string[] = [];
  const context = {
    writeOriginScript: async (_origin: string, s: string) => {
      scripts.push(s);
    },
  };
  const entries = [
    { key: 'session', value: 'preserved 🦋' },
    { key: 'empty', value: '' },
  ];
  await injectLocalStorageState(
    context,
    [{ origin: origin.replace('https://', 'ttps://'), entries }],
    Date.now()
  );
  const records = [
    { key: 'one', value: { message: 'value 🦋', count: 2 } },
    { key: 'two', value: null },
  ];
  await injectIndexedDBState(
    context,
    [{ origin, databases: [{ name: 'fixture-db', objectStores: [{ name: 'records', records }] }] }],
    Date.now()
  );
  await injectCacheStorageState(
    context,
    [{ origin, caches: [{ name: 'cache-a', size: 42 }] }],
    Date.now()
  );
  const stored = new Map<string, string>();
  const writes: unknown[] = [];
  const openedCaches: string[] = [];
  const stores = new Set<string>();
  const db = {
    version: 1,
    close: () => {},
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => {
      stores.add(n);
    },
    transaction: (name: string) => {
      const tx: {
        oncomplete?: () => void;
        objectStore: () => { put: (value: unknown, key: unknown) => void };
      } = {
        objectStore: () => ({
          put: (value: unknown, key: unknown) => {
            writes.push({ name, key, value });
          },
        }),
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  const indexedDB = {
    open: (_name: string, version?: number) => {
      const request: { onupgradeneeded?: (e: unknown) => void; onsuccess?: (e: unknown) => void } =
        {};
      queueMicrotask(() => {
        const event = { target: { result: db } };
        if (version !== undefined) request.onupgradeneeded?.(event);
        request.onsuccess?.(event);
      });
      return request;
    },
  };
  const vm = createContext({
    window: { location: { origin } },
    localStorage: { setItem: (k: string, v: string) => stored.set(k, v) },
    indexedDB,
    caches: {
      open: async (name: string) => {
        openedCaches.push(name);
      },
    },
  });
  for (const s of [...scripts].reverse()) await runInContext(s, vm);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert(
    JSON.stringify([...stored]) === JSON.stringify(entries.map((e) => [e.key, e.value])),
    'localStorage restore changed entries'
  );
  assert(
    JSON.stringify(writes) ===
      JSON.stringify(records.map((r) => ({ name: 'records', key: r.key, value: r.value }))),
    'IndexedDB restore changed stores, keys, or values'
  );
  assert(
    JSON.stringify(openedCaches) === JSON.stringify(['cache-a']),
    'CacheStorage names changed'
  );
  console.log(
    '✅ localStorage, IndexedDB stores/records, and CacheStorage names restore unchanged'
  );
}

async function verifyAbort() {
  const abort = new AbortController();
  let calls = 0;
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = injectOriginPayload(
    {
      writeOriginScript: async () => {
        calls++;
        await first;
      },
    },
    { origin },
    'LocalStorageOrigin',
    'window.received.push(data);',
    { text: 'x'.repeat(3000000) },
    origin,
    abort.signal
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert(calls === 1, 'mutations overlapped before cancellation');
  abort.abort();
  release();
  let rejected = false;
  try {
    await run;
  } catch {
    rejected = true;
  }
  assert(rejected && calls === 1, 'canceled transfer registered later chunks or completion');
  console.log('✅ timeout cancellation fences every later chunk and completion mutation');
}

async function verifyDatabaseScopeAndRevision() {
  const userId = `origin-payload-${randomUUID()}`;
  const value = [{ key: 'session', value: 'x'.repeat(6000000) }];
  const row = await prisma.localStorageOrigin.create({
    data: { userId, origin, entries: value, hash: 'before' },
    select: { id: true, userId: true, origin: true, hash: true, updatedAt: true },
  });
  try {
    let calls = 0;
    const scripts: string[] = [];
    let rejected = false;
    try {
      await injectOriginPayload(
        {
          writeOriginScript: async (_origin, script) => {
            scripts.push(script);
            if (++calls === 1)
              await prisma.localStorageOrigin.update({
                where: { id: row.id },
                data: { entries: [], hash: 'after' },
              });
          },
        },
        row,
        'LocalStorageOrigin',
        'window.received.push(data);'
      );
    } catch {
      rejected = true;
    }
    const r = receiver();
    for (const script of scripts) runInContext(script, r.vm);
    assert(rejected && r.window.received.length === 0, 'changed blob restored mixed revisions');
    const current = await prisma.localStorageOrigin.findUniqueOrThrow({
      where: { id: row.id },
      select: { id: true, userId: true, origin: true, hash: true, updatedAt: true },
    });
    for (const wrong of [
      { ...current, userId: 'other-user' },
      { ...current, origin: 'https://other.origin.test' },
    ]) {
      let mutations = 0,
        denied = false;
      try {
        await injectOriginPayload(
          {
            writeOriginScript: async () => {
              mutations++;
            },
          },
          wrong,
          'LocalStorageOrigin',
          'window.received.push(data);'
        );
      } catch {
        denied = true;
      }
      assert(denied && mutations === 0, 'opaque read crossed selected user or origin');
    }
    console.log('✅ real Postgres payload reads retain user/origin/revision boundaries');
  } finally {
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
  }
}

async function verifyDatabaseUnicodeAndAbort() {
  const userId = `origin-payload-unicode-${randomUUID()}`;
  const value = [{ key: 'unicode', value: `x${'🦋'.repeat(1_100_000)}` }];
  const row = await prisma.localStorageOrigin.create({
    data: { userId, origin, entries: value, hash: 'unicode' },
    select: { id: true, userId: true, origin: true, hash: true, updatedAt: true },
  });
  try {
    const scripts: string[] = [];
    await injectOriginPayload(
      {
        writeOriginScript: async (_origin, s) => {
          scripts.push(s);
        },
      },
      row,
      'LocalStorageOrigin',
      'window.received.push(data);'
    );
    const r = receiver();
    for (const script of [...scripts].reverse()) runInContext(script, r.vm);
    assert(
      JSON.stringify(r.window.received) === JSON.stringify([value]),
      'SQL byte boundaries changed astral Unicode'
    );
    const abort = new AbortController();
    let calls = 0;
    let rejected = false;
    try {
      await injectOriginPayload(
        {
          writeOriginScript: async () => {
            calls++;
            abort.abort();
          },
        },
        row,
        'LocalStorageOrigin',
        'window.received.push(data);',
        undefined,
        origin,
        abort.signal
      );
    } catch {
      rejected = true;
    }
    assert(rejected && calls === 1, 'SQL-backed cancellation registered later mutations');
    console.log('✅ SQL byte streaming preserves astral Unicode and fences canceled mutations');
  } finally {
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
  }
}

/**
 * Production defaults, prod realm shape (agent 07281fc3): init for an admin.*
 * start URL beside a sibling Drive-style cache over the restore budget, plus
 * the stored localStorage keys the Mac reader writes. The cache reaches no
 * browser mutation, partitioned third-party keys are never replayed as
 * first-party storage, and an origin's Mac and harvest rows share one visit.
 */
async function verifyRealmRestoreBudget() {
  const realm = `restore-budget-${randomUUID().slice(0, 8)}.test`;
  const cache = `https://drive.${realm}`;
  const admin = `https://admin.${realm}`;
  const thirdParty = 'https://fp.third-party.test';
  const userId = `origin-restore-budget-${randomUUID()}`;
  const sessionId = `origin-restore-budget-session-${randomUUID()}`;
  const context = await prisma.browserContext.create({ data: { userId } });
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId,
      wsUrl: `ws://${realm}`,
      provider: 'kernel',
      status: 'ACTIVE',
    },
  });
  try {
    // ~27 MB of md5 records: the shape of a desktop module cache.
    await prisma.$executeRaw`
      INSERT INTO "IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
      SELECT ${randomUUID()}, ${userId}, ${cache},
        ('[{"name":"ODPMC","objectStores":[{"name":"modules","records":[' ||
          (SELECT string_agg(jsonb_build_object('key', 'm' || i,
              'value', md5(i::text) || md5((i * 7)::text) || md5((i * 13)::text))::text,
              ',' ORDER BY i)
            FROM generate_series(1, 200000) i) || ']}]}]')::jsonb,
        'module-cache', now()`;
    const [{ bytes }] = await prisma.$queryRaw<Array<{ bytes: number }>>`
      SELECT octet_length(databases::text)::int AS bytes FROM "IndexedDBOrigin"
      WHERE "userId" = ${userId} AND origin = ${cache}`;
    assert(bytes > 8 * 1024 * 1024, `fixture cache is not over the default budget: ${bytes}`);
    const small = [
      { name: 'auth', objectStores: [{ name: 'kv', records: [{ key: 'k', value: 'v' }] }] },
    ];
    await prisma.indexedDBOrigin.create({
      data: { userId, origin: `https://mail.${realm}`, databases: small, hash: 'small' },
    });
    const stored = [
      { origin: `https://accounts.${realm}`, value: 'accounts', at: 1 },
      { origin: admin, value: 'harvest-newer', at: 3 },
      { origin: admin.replace('https://', 'ttps://'), value: 'mac-older', at: 2 },
      {
        origin: `${thirdParty}/^0https://${realm}`.replace('https://', 'ttps://'),
        value: 'fp',
        at: 1,
      },
    ];
    for (const row of stored) {
      await prisma.localStorageOrigin.create({
        data: {
          userId,
          origin: row.origin,
          entries: [{ key: 'shared', value: row.value }],
          hash: row.value,
          updatedAt: new Date(Date.UTC(2026, 9, 12, 0, 0, row.at)),
        },
      });
    }
    const delivered = new Map<string, number>();
    const navigations: string[] = [];
    const adminWrites: string[] = [];
    let pageUrl = 'about:blank';
    const browser = {
      contexts: () => [
        {
          addCookies: async () => undefined,
          addInitScript: async () => undefined,
          newCDPSession: async () => ({ send: async () => undefined }),
          newPage: async () => ({
            route: async () => undefined,
            url: () => pageUrl,
            goto: async (url: string) => {
              pageUrl = url;
              navigations.push(new URL(url).origin);
            },
            close: async () => undefined,
            evaluate: async (script: string) => {
              const target = new URL(pageUrl).origin;
              delivered.set(target, (delivered.get(target) ?? 0) + Buffer.byteLength(script));
              if (target === admin)
                adminWrites.push(/(mac-older|harvest-newer)/.exec(script)?.[1] ?? '');
            },
          }),
        },
      ],
      close: async () => undefined,
    } as unknown as Browser;
    const result = await injectUserData(sessionId, userId, `${admin}/ac/users`, { browser });
    assert(
      !delivered.has(cache),
      `over-budget origin reached the browser: ${delivered.get(cache)} bytes`
    );
    assert(
      result.indexedDB.originCount === 1 && (delivered.get(`https://mail.${realm}`) ?? 0) > 0,
      'within-budget IndexedDB sibling was not restored'
    );
    assert(
      !navigations.includes(thirdParty),
      'partitioned third-party storage was replayed first-party'
    );
    assert(
      navigations.filter((o) => o === admin).length === 1 &&
        JSON.stringify(adminWrites) === JSON.stringify(['mac-older', 'harvest-newer']),
      `one origin's rows were not restored oldest-first in one visit: ${JSON.stringify({ navigations, adminWrites })}`
    );
    assert(result.localStorage.originCount === 2, 'localStorage siblings were not restored');
    console.log(`✅ realm init skips a ${bytes}-byte cache and restores first-party siblings`);
  } finally {
    await prisma.indexedDBOrigin.deleteMany({ where: { userId } });
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

(async () => {
  try {
    await verifyAssembly();
    await verifyReceivers();
    await verifyAbort();
    await verifyDatabaseScopeAndRevision();
    await verifyDatabaseUnicodeAndAbort();
    await verifyRealmRestoreBudget();
  } finally {
    await prisma.$disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
