#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { assertLocalDatabase } from './assertLocalDatabase';
import { prisma } from '../../providers/database';
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
      addInitScript: async (script) => {
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
    addInitScript: async (s: string) => {
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
    transaction: (name: string) => ({
      objectStore: () => ({
        put: (value: unknown, key: unknown) => {
          writes.push({ name, key, value });
        },
      }),
    }),
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
  for (const s of [...scripts].reverse()) runInContext(s, vm);
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
      addInitScript: async () => {
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
          addInitScript: async (script) => {
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
            addInitScript: async () => {
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
        addInitScript: async (s) => {
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
          addInitScript: async () => {
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

(async () => {
  try {
    await verifyAssembly();
    await verifyReceivers();
    await verifyAbort();
    await verifyDatabaseScopeAndRevision();
    await verifyDatabaseUnicodeAndAbort();
  } finally {
    await prisma.$disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
