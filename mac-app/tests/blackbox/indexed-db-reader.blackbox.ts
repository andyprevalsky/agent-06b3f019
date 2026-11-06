/**
 * indexed-db-reader domain blackbox
 *
 * Surface under test: the fully-native Chrome IndexedDB reader
 * (`main/domains/indexed-db-reader/`), which replaced the old
 * `spawn('python3', scripts/read_indexeddb.py)` path. There is NO python
 * dependency anymore — decoding is pure TypeScript
 * (`native/leveldb.ts` + `native/v8-deserializer.ts` +
 * `native/blink-deserializer.ts` + `native/indexeddb.ts`), validated
 * byte-for-byte against `ccl_chromium_reader` across real Chrome profiles.
 *
 * These tests build a REAL Chrome-format IndexedDB LevelDB write-ahead log on
 * disk (global/database/object-store metadata records + object-store data
 * records whose values are produced by Node's `v8.serialize`, which emits the
 * same wire format Chrome's Blink serializer uses) and then assert the reader
 * decodes it correctly end-to-end.
 *
 * Observable behavior exercised here:
 *   - readIndexedDbDatabases() decodes databases → object stores → records,
 *     round-tripping strings, numbers, booleans, null, nested objects, and
 *     arrays through the V8 deserializer.
 *   - The service layer (readIndexedDB) discovers the active Chrome profile,
 *     filters by origin, derives the origin from the folder name, and attaches
 *     a stable per-origin sha256(16) change-detection hash.
 *   - Folder discovery finds/filters `*.indexeddb.leveldb` folders and picks
 *     the most-recently-modified profile.
 *   - No IndexedDB folders / no Chrome profile → empty result (never throws).
 *   - Zero outbound HTTP calls (this domain only touches the filesystem).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import v8 from 'v8';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';
import { snappyDecompressBlock } from '../../main/domains/indexed-db-reader/native/snappy';

// ── Electron app.getPath stub (home is redirected per-test to a temp dir) ────
const homeRef = { dir: '/tmp/does-not-exist' };
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => homeRef.dir) },
}));

// ── LevelDB / IndexedDB fixture builders ─────────────────────────────────────
// Minimal encoders mirroring Chromium's leveldb_coding_scheme so we can write a
// genuine `.log` the reader parses. Only what the fixtures need is implemented.

function leVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

function utf16be(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push((c >> 8) & 0xff, c & 0xff);
  }
  return out;
}

function leBytes(val: number): number[] {
  if (val === 0) return [0];
  const out: number[] = [];
  let v = val;
  while (v > 0) {
    out.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}

function makePrefix(dbId: number, storeId: number, indexId: number, end: number[] = []): number[] {
  const sizes = (n: number): number => leBytes(n).length;
  const byteOne = ((sizes(dbId) - 1) << 5) | ((sizes(storeId) - 1) << 2) | (sizes(indexId) - 1);
  return [byteOne, ...leBytes(dbId), ...leBytes(storeId), ...leBytes(indexId), ...end];
}

/** Encode a String IdbKey: type 1, varint char-count, utf16-be chars. */
function idbStringKey(s: string): number[] {
  return [1, ...leVarint(s.length), ...utf16be(s)];
}

function float64le(n: number): number[] {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n, 0);
  return Array.from(b);
}

/** Encode a Number IdbKey (type 3) — float64 LE. */
function idbNumberKey(n: number): number[] {
  return [3, ...float64le(n)];
}

/** Encode a Date IdbKey (type 2) — float64 LE milliseconds. */
function idbDateKey(ms: number): number[] {
  return [2, ...float64le(ms)];
}

/** Encode a Binary IdbKey (type 6) — varint length + bytes. */
function idbBinaryKey(bytes: number[]): number[] {
  return [6, ...leVarint(bytes.length), ...bytes];
}

/** Encode an Array IdbKey (type 4) — varint count + inner keys. */
function idbArrayKey(inner: number[][]): number[] {
  return [4, ...leVarint(inner.length), ...inner.flat()];
}

/** Wrap a v8-serialized value in the IndexedDB value envelope (blink version 17, no trailer). */
function idbValue(value: unknown): number[] {
  const v8Payload = Array.from(v8.serialize(value)); // starts with 0xFF <v8ver>
  return [
    0x01 /* idb value version */,
    0xff /* blink tag */,
    0x11 /* blink version 17 */,
    ...v8Payload,
  ];
}

interface KvPair {
  key: number[];
  value: number[];
  /** When true, written as a LevelDB delete tombstone (key only, no value). */
  del?: boolean;
}

/** Build the leveldb key/value pairs for one database with one object store. */
function idbRecords(opts: {
  dbId: number;
  origin: string;
  dbName: string;
  storeId: number;
  storeName: string;
  records: { key: string; value: unknown }[];
}): KvPair[] {
  const pairs: KvPair[] = [];
  // Database id record: 00 00 00 00 c9 <origin><name> -> db id (truncated int)
  pairs.push({
    key: [
      0,
      0,
      0,
      0,
      0xc9,
      ...leVarint(opts.origin.length),
      ...utf16be(opts.origin),
      ...leVarint(opts.dbName.length),
      ...utf16be(opts.dbName),
    ],
    value: leBytes(opts.dbId),
  });
  // Database metadata: MaximumObjectStoreId (meta type 3)
  pairs.push({ key: [...makePrefix(opts.dbId, 0, 0), 3], value: leBytes(opts.storeId) });
  // Object store metadata: StoreName (meta type 0), value is utf16-be name
  pairs.push({
    key: [...makePrefix(opts.dbId, 0, 0, [50]), ...leVarint(opts.storeId), 0],
    value: utf16be(opts.storeName),
  });
  // Object store data records
  for (const rec of opts.records) {
    pairs.push({
      key: [...makePrefix(opts.dbId, opts.storeId, 1), ...idbStringKey(rec.key)],
      value: idbValue(rec.value),
    });
  }
  return pairs;
}

/** Frame key/value pairs into a single-block leveldb `.log` file and write it. */
function writeLevelDbLog(leveldbDir: string, pairs: KvPair[]): void {
  fs.mkdirSync(leveldbDir, { recursive: true });
  fs.writeFileSync(path.join(leveldbDir, '000001.log'), encodeLevelDbLog(pairs));
}

/**
 * Write a large store as many single-block `.log` files (each batch must fit
 * one 32 KiB log block), the way a long-lived Chrome profile accumulates them.
 */
function writeLevelDbLogFiles(leveldbDir: string, pairs: KvPair[], perFile: number): void {
  fs.mkdirSync(leveldbDir, { recursive: true });
  for (let i = 0; i * perFile < pairs.length; i++) {
    const chunk = pairs.slice(i * perFile, (i + 1) * perFile);
    const name = `${String(i + 1).padStart(6, '0')}.log`;
    fs.writeFileSync(path.join(leveldbDir, name), encodeLevelDbLog(chunk, i * perFile + 1));
  }
}

/** Frame key/value pairs into one single-block leveldb `.log` file's bytes. */
function encodeLevelDbLog(pairs: KvPair[], seq = 1): Buffer {
  // WriteBatch: seq(8 LE) | count(4 LE) | entries[ type(1)=Put | keyLen varint | key | valLen varint | val ]
  const batch: number[] = [];
  for (let i = 0; i < 8; i++) batch.push(Math.floor(seq / 2 ** (i * 8)) & 0xff);
  const count = pairs.length;
  for (let i = 0; i < 4; i++) batch.push((count >> (i * 8)) & 0xff);
  for (const p of pairs) {
    if (p.del === true) {
      batch.push(0); // Delete (tombstone) — key only, no value
      batch.push(...leVarint(p.key.length), ...p.key);
      continue;
    }
    batch.push(1); // Put
    batch.push(...leVarint(p.key.length), ...p.key);
    batch.push(...leVarint(p.value.length), ...p.value);
  }
  // Physical log record: crc(4, ignored by reader) | length(2 LE) | type(1)=Full | data
  return Buffer.from([0, 0, 0, 0, batch.length & 0xff, (batch.length >> 8) & 0xff, 1, ...batch]);
}

/** Create the Chrome profile tree (with a Preferences file) and return the leveldb dir. */
function profileIdbDir(home: string, folderName: string, profileName = 'Default'): string {
  const profile = path.join(
    home,
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    profileName
  );
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'Preferences'), '{}');
  return path.join(profile, 'IndexedDB', folderName);
}

/** Build a full Chrome-profile tree under `home` and return the leveldb dir. */
function buildChromeProfile(home: string, folderName: string, pairs: KvPair[]): string {
  const leveldbDir = profileIdbDir(home, folderName);
  writeLevelDbLog(leveldbDir, pairs);
  return leveldbDir;
}

/** The three metadata KV pairs (db id + MaximumObjectStoreId + StoreName) for one store. */
function idbMetadata(
  dbId: number,
  origin: string,
  dbName: string,
  storeId: number,
  storeName: string
): KvPair[] {
  return [
    {
      key: [
        0,
        0,
        0,
        0,
        0xc9,
        ...leVarint(origin.length),
        ...utf16be(origin),
        ...leVarint(dbName.length),
        ...utf16be(dbName),
      ],
      value: leBytes(dbId),
    },
    { key: [...makePrefix(dbId, 0, 0), 3], value: leBytes(storeId) },
    { key: [...makePrefix(dbId, 0, 0, [50]), ...leVarint(storeId), 0], value: utf16be(storeName) },
  ];
}

/** One object-store data record with an arbitrary encoded IdbKey and a value. */
function idbDataRecord(dbId: number, storeId: number, keyBytes: number[], value: unknown): KvPair {
  return { key: [...makePrefix(dbId, storeId, 1), ...keyBytes], value: idbValue(value) };
}

/** Hand-build an all-literal Snappy block (no compressor needed). */
function snappyLiteralBlock(data: number[]): number[] {
  const n = data.length;
  const header = [...leVarint(n)]; // uncompressed length prefix
  if (n <= 60) {
    header.push((n - 1) << 2); // literal length embedded in the tag
  } else if (n <= 256) {
    header.push(60 << 2, n - 1); // 8-bit literal length follows the tag
  } else {
    header.push(61 << 2, (n - 1) & 0xff, ((n - 1) >> 8) & 0xff); // 16-bit LE
  }
  return [...header, ...data];
}

/** Encode a single LevelDB table block: entries (shared=0) + restart array. */
function encodeTableBlock(entries: KvPair[]): number[] {
  const body: number[] = [];
  for (const p of entries) {
    body.push(
      ...leVarint(0),
      ...leVarint(p.key.length),
      ...leVarint(p.value.length),
      ...p.key,
      ...p.value
    );
  }
  body.push(0, 0, 0, 0); // single restart offset = 0
  body.push(1, 0, 0, 0); // restart count = 1
  return body;
}

/**
 * Write a minimal single-data-block LevelDB SSTable (`.ldb`). Keys become
 * internal keys (user key + 8-byte trailer whose `key[-8]` byte is the type:
 * 1 = Live). When `compress` is set, the data block is stored as a hand-built
 * all-literal Snappy block so the reader's decompression path runs.
 */
function writeLevelDbSSTable(leveldbDir: string, pairs: KvPair[], compress = false): void {
  fs.mkdirSync(leveldbDir, { recursive: true });
  const blockHandle = (offset: number, length: number): number[] => [
    ...leVarint(offset),
    ...leVarint(length),
  ];
  // Trailer = [type=1 (Live), seq(7 bytes LE)] → key[-8] === 1.
  const framed = pairs.map((p, i) => ({
    key: [...p.key, 1, i + 1, 0, 0, 0, 0, 0, 0],
    value: p.value,
  }));

  const rawData = encodeTableBlock(framed);
  const dataBytes = compress ? snappyLiteralBlock(rawData) : rawData;
  const out: number[] = [...dataBytes, compress ? 1 : 0, 0, 0, 0, 0]; // block + trailer(compression|crc)
  const dataHandle = blockHandle(0, dataBytes.length);

  const indexOffset = out.length;
  const indexRaw = encodeTableBlock([{ key: framed[framed.length - 1].key, value: dataHandle }]);
  out.push(...indexRaw, 0, 0, 0, 0, 0); // index block + trailer (uncompressed)
  const indexHandle = blockHandle(indexOffset, indexRaw.length);

  const footer: number[] = [...blockHandle(0, 0), ...indexHandle]; // metaindex(empty) + index
  while (footer.length < 40) footer.push(0);
  const magic = Buffer.alloc(8);
  magic.writeBigUInt64LE(0xdb4775248b80fb57n, 0);
  footer.push(...Array.from(magic));

  fs.writeFileSync(path.join(leveldbDir, '000002.ldb'), Buffer.from([...out, ...footer]));
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('indexed-db-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;
  let tmp: string;

  beforeEach(() => {
    clearFetchCaptures();
    restoreFetch = installFetchCapture({});
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idb-reader-'));
    homeRef.dir = tmp;
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // native decode
  // ------------------------------------------------------------------
  describe('native decode', () => {
    it('decodes databases, object stores, and records (multiple value types) from a real leveldb log', async () => {
      const value = {
        qty: 2,
        name: 'widget',
        active: true,
        tags: ['a', 'b'],
        note: null,
        nested: { n: 7 },
      };
      const leveldbDir = buildChromeProfile(
        tmp,
        'https_www.amazon.com_0.indexeddb.leveldb',
        idbRecords({
          dbId: 1,
          origin: 'https://www.amazon.com',
          dbName: 'cart-db',
          storeId: 1,
          storeName: 'items',
          records: [
            { key: 'asin-1', value },
            { key: 'asin-2', value: 'plain-string' },
          ],
        })
      );

      const { readIndexedDbDatabases } =
        await import('../../main/domains/indexed-db-reader/native/indexeddb');
      const databases = readIndexedDbDatabases(leveldbDir);

      expect(databases).toHaveLength(1);
      expect(databases[0].name).toBe('cart-db');
      expect(databases[0].objectStores).toHaveLength(1);
      const store = databases[0].objectStores[0];
      expect(store.name).toBe('items');
      expect(store.records).toHaveLength(2);

      const byKey = new Map(store.records.map((r) => [r.key as string, r.value]));
      expect(byKey.get('asin-1')).toEqual(value);
      expect(byKey.get('asin-2')).toBe('plain-string');
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // service orchestration (discovery + filter + origin + hash)
  // ------------------------------------------------------------------
  describe('service orchestration', () => {
    it('discovers the profile, filters by origin, derives the origin, and attaches a per-origin hash', async () => {
      buildChromeProfile(
        tmp,
        'https_www.amazon.com_0.indexeddb.leveldb',
        idbRecords({
          dbId: 1,
          origin: 'https://www.amazon.com',
          dbName: 'db',
          storeId: 1,
          storeName: 's',
          records: [{ key: 'k', value: { v: 1 } }],
        })
      );

      const { IndexedDBReader } = await import('../../main/domains/indexed-db-reader/runtime');
      const readIndexedDB = (f?: string) => IndexedDBReader.readIndexedDB(f);
      const result = await readIndexedDB('amazon');

      expect(result.origins).toHaveLength(1);
      expect(result.origins[0].origin).toBe('https://www.amazon.com');
      expect(result.origins[0].databases[0].objectStores[0].records[0].value).toEqual({ v: 1 });
      expect(result.hashes['https://www.amazon.com']).toMatch(/^[a-f0-9]{16}$/);
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns the same hash across calls for identical data and a different hash when data changes', async () => {
      const build = (val: unknown): void => {
        fs.rmSync(path.join(tmp, 'Library'), { recursive: true, force: true });
        buildChromeProfile(
          tmp,
          'https_x.com_0.indexeddb.leveldb',
          idbRecords({
            dbId: 1,
            origin: 'https://x.com',
            dbName: 'd',
            storeId: 1,
            storeName: 's',
            records: [{ key: 'k', value: val }],
          })
        );
      };

      const { IndexedDBReader } = await import('../../main/domains/indexed-db-reader/runtime');
      const readIndexedDB = (f?: string) => IndexedDBReader.readIndexedDB(f);
      build({ n: 1 });
      const h1 = (await readIndexedDB('x.com')).hashes['https://x.com'];
      build({ n: 1 });
      const h2 = (await readIndexedDB('x.com')).hashes['https://x.com'];
      build({ n: 2 });
      const h3 = (await readIndexedDB('x.com')).hashes['https://x.com'];

      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
    });

    it('returns an empty result when no IndexedDB folders match / no Chrome profile exists', async () => {
      const { IndexedDBReader } = await import('../../main/domains/indexed-db-reader/runtime');
      const readIndexedDB = (f?: string) => IndexedDBReader.readIndexedDB(f);

      // No profile at all.
      expect(await readIndexedDB('anything')).toEqual({ origins: [], hashes: {} });

      // Profile exists but filter matches nothing.
      buildChromeProfile(
        tmp,
        'https_www.amazon.com_0.indexeddb.leveldb',
        idbRecords({
          dbId: 1,
          origin: 'https://www.amazon.com',
          dbName: 'd',
          storeId: 1,
          storeName: 's',
          records: [],
        })
      );
      expect(await readIndexedDB('doordash')).toEqual({ origins: [], hashes: {} });
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // discovery
  // ------------------------------------------------------------------
  describe('folder discovery', () => {
    it('finds and origin-decodes leveldb folders, filtering case-insensitively', async () => {
      buildChromeProfile(tmp, 'https_www.amazon.com_0.indexeddb.leveldb', []);
      const idbBase = path.join(
        tmp,
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'Default',
        'IndexedDB'
      );
      fs.mkdirSync(path.join(idbBase, 'https_www.doordash.com_0.indexeddb.leveldb'), {
        recursive: true,
      });

      const { findIndexedDbFolders, originFromFolderName } =
        await import('../../main/domains/indexed-db-reader/native/discovery');
      expect(originFromFolderName('https_www.amazon.com_0.indexeddb.leveldb')).toBe(
        'https://www.amazon.com'
      );
      expect(originFromFolderName('http_localhost_5173.indexeddb.leveldb')).toBe(
        'http://localhost'
      );

      const all = findIndexedDbFolders(tmp);
      expect(all.map((f) => f.origin).sort()).toEqual([
        'https://www.amazon.com',
        'https://www.doordash.com',
      ]);

      const filtered = findIndexedDbFolders(tmp, 'AMAZON');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].origin).toBe('https://www.amazon.com');
    });

    it('picks the most-recently-modified profile and resolves a sibling blob dir', async () => {
      // Two profiles; the newer one wins.
      const oldDir = profileIdbDir(tmp, 'https_a.com_0.indexeddb.leveldb', 'Default');
      writeLevelDbLog(oldDir, idbMetadata(1, 'https://a.com', 'd', 1, 's'));
      const newDir = profileIdbDir(tmp, 'https_b.com_0.indexeddb.leveldb', 'Profile 1');
      writeLevelDbLog(newDir, idbMetadata(1, 'https://b.com', 'd', 1, 's'));
      // Make Profile 1's Preferences the most recent.
      const prefsNew = path.join(
        tmp,
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'Profile 1',
        'Preferences'
      );
      fs.utimesSync(prefsNew, new Date(2030, 0, 1), new Date(2030, 0, 1));
      // A sibling blob dir should be picked up.
      fs.mkdirSync(path.join(path.dirname(newDir), 'https_b.com_0.indexeddb.blob'), {
        recursive: true,
      });

      const { findIndexedDbFolders } =
        await import('../../main/domains/indexed-db-reader/native/discovery');
      const folders = findIndexedDbFolders(tmp);
      expect(folders.map((f) => f.origin)).toEqual(['https://b.com']);
      expect(folders[0].blobDir).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // value + key type coverage
  // ------------------------------------------------------------------
  describe('value and key type decoding', () => {
    it('round-trips the full structured-clone value matrix into the serialized shape', async () => {
      const values: Record<string, unknown> = {
        m: new Map<string, number>([['a', 1]]),
        s: new Set<number>([1, 2]),
        big: 123n,
        date: new Date(1000),
        nan: NaN,
        inf: Infinity,
        ninf: -Infinity,
        arr: [1, 'two', false],
        latin: 'café', // Latin-1 → V8 OneByteString → bytes
      };
      const records = Object.entries(values).map(([k, v]) =>
        idbDataRecord(1, 1, idbStringKey(k), v)
      );
      const leveldbDir = buildChromeProfile(tmp, 'https_x.com_0.indexeddb.leveldb', [
        ...idbMetadata(1, 'https://x.com', 'd', 1, 'store'),
        ...records,
      ]);

      const { readIndexedDbDatabases } =
        await import('../../main/domains/indexed-db-reader/native/indexeddb');
      const recs = readIndexedDbDatabases(leveldbDir)[0].objectStores[0].records;
      const byKey = new Map(recs.map((r) => [r.key as string, r.value]));

      expect(byKey.get('m')).toEqual({ __type: 'Map', entries: [['a', 1]] });
      expect(byKey.get('s')).toEqual({ __type: 'Set', values: [1, 2] });
      expect(byKey.get('big')).toEqual({ __type: 'bigint', value: '123' });
      expect(byKey.get('date')).toBe(new Date(1000).toISOString());
      expect(byKey.get('nan')).toEqual({ __type: 'NaN' });
      expect(byKey.get('inf')).toEqual({ __type: 'Infinity', sign: 1 });
      expect(byKey.get('ninf')).toEqual({ __type: 'Infinity', sign: -1 });
      expect(byKey.get('arr')).toEqual([1, 'two', false]);
      expect(byKey.get('latin')).toMatchObject({ __type: 'bytes' });
    });

    it('decodes every IndexedDB primary-key type', async () => {
      const records = [
        idbDataRecord(1, 1, idbNumberKey(42), 'n'),
        idbDataRecord(1, 1, idbDateKey(1000), 'd'),
        idbDataRecord(1, 1, idbBinaryKey([1, 2, 3]), 'b'),
        idbDataRecord(1, 1, idbArrayKey([idbStringKey('a'), idbNumberKey(7)]), 'arr'),
      ];
      const leveldbDir = buildChromeProfile(tmp, 'https_k.com_0.indexeddb.leveldb', [
        ...idbMetadata(1, 'https://k.com', 'd', 1, 'store'),
        ...records,
      ]);

      const { readIndexedDbDatabases } =
        await import('../../main/domains/indexed-db-reader/native/indexeddb');
      const keys = readIndexedDbDatabases(leveldbDir)[0].objectStores[0].records.map((r) => r.key);
      expect(keys).toContainEqual(42);
      expect(keys).toContainEqual(new Date(1000).toISOString());
      expect(keys).toContainEqual('010203'); // binary → hex
      expect(keys).toContainEqual(['a', 7]); // array key
    });

    it('yields a null-valued record for a delete tombstone (empty value)', async () => {
      const leveldbDir = buildChromeProfile(tmp, 'https_d.com_0.indexeddb.leveldb', [
        ...idbMetadata(1, 'https://d.com', 'd', 1, 'store'),
        { key: [...makePrefix(1, 1, 1), ...idbStringKey('gone')], value: [], del: true },
      ]);

      const { readIndexedDbDatabases } =
        await import('../../main/domains/indexed-db-reader/native/indexeddb');
      const recs = readIndexedDbDatabases(leveldbDir)[0].objectStores[0].records;
      expect(recs).toEqual([{ key: 'gone', value: null }]);
    });
  });

  // ------------------------------------------------------------------
  // main-process responsiveness (beachball regression)
  // ------------------------------------------------------------------
  describe('main-process responsiveness', () => {
    /** Run `work` while a 5ms interval records the longest event-loop stall. */
    async function longestStallDuring(work: () => Promise<unknown>): Promise<number> {
      let last = performance.now();
      let longest = 0;
      const probe = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 5);
      try {
        last = performance.now();
        await work();
        const now = performance.now();
        return Math.max(longest, now - last);
      } finally {
        clearInterval(probe);
      }
    }

    /** A Gmail-offline-sized store: thousands of message-like records over many log files. */
    function buildLargeGoogleStore(): string {
      const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12);
      const records: KvPair[] = [];
      for (let i = 0; i < 8000; i++) {
        records.push(
          idbDataRecord(1, 1, idbStringKey(`m${i}`), {
            id: `m${i}`,
            thread: `t${i % 97}`,
            from: `person${i % 31}@example.com`,
            labels: ['INBOX', `L${i % 7}`],
            ts: 1_700_000_000_000 + i,
            body: `${body}${i}`,
          })
        );
      }
      const leveldbDir = profileIdbDir(tmp, 'https_mail.google.com_0.indexeddb.leveldb');
      writeLevelDbLogFiles(
        leveldbDir,
        [...idbMetadata(1, 'https://mail.google.com', 'offline', 1, 'messages'), ...records],
        20
      );
      return leveldbDir;
    }

    it('keeps the event loop responsive while scanning a large IndexedDB (no beachball)', async () => {
      const leveldbDir = buildLargeGoogleStore();
      const { readIndexedDbDatabases } =
        await import('../../main/domains/indexed-db-reader/native/indexeddb');
      const { IndexedDBReader } = await import('../../main/domains/indexed-db-reader/runtime');
      const { computeOriginHash } = await import('../../main/domains/indexed-db-reader/service');

      // Control: the old synchronous decode holds the loop for the whole scan.
      let syncDatabases: ReturnType<typeof readIndexedDbDatabases> = [];
      const syncStall = await longestStallDuring(async () => {
        syncDatabases = readIndexedDbDatabases(leveldbDir);
        await Promise.resolve();
      });

      let result: Awaited<ReturnType<typeof IndexedDBReader.readIndexedDB>> | null = null;
      const slicedStall = await longestStallDuring(async () => {
        result = await IndexedDBReader.readIndexedDB('google');
      });

      console.log(
        `[indexed-db-reader] longest event-loop stall: sync ${Math.round(syncStall)}ms, ` +
          `sliced ${Math.round(slicedStall)}ms`
      );
      // The fixture is heavy enough that a synchronous scan visibly freezes the app…
      expect(syncStall).toBeGreaterThan(200);
      // …while the production path stays far below beachball scale (~2s), even on a loaded host.
      expect(slicedStall).toBeLessThan(250);
      expect(slicedStall * 3).toBeLessThan(syncStall);

      // Same decoded payload and the same change-detection hash as before.
      const origin = { origin: 'https://mail.google.com', databases: syncDatabases };
      expect(result).not.toBeNull();
      const { origins, hashes } = result as unknown as Awaited<
        ReturnType<typeof IndexedDBReader.readIndexedDB>
      >;
      expect(origins).toEqual([origin]);
      expect(origins[0].databases[0].objectStores[0].records).toHaveLength(8000);
      expect(hashes['https://mail.google.com']).toBe(computeOriginHash(origin));
    }, 60_000);
  });

  // ------------------------------------------------------------------
  // LevelDB SSTable (.ldb) path
  // ------------------------------------------------------------------
  describe('SSTable (.ldb) reading', () => {
    it('reads records from an uncompressed .ldb table file', async () => {
      const leveldbDir = profileIdbDir(tmp, 'https_t.com_0.indexeddb.leveldb');
      writeLevelDbSSTable(leveldbDir, [
        ...idbMetadata(1, 'https://t.com', 'd', 1, 'store'),
        idbDataRecord(1, 1, idbStringKey('k'), { v: 5 }),
      ]);

      const { readIndexedDbDatabases } =
        await import('../../main/domains/indexed-db-reader/native/indexeddb');
      const recs = readIndexedDbDatabases(leveldbDir)[0].objectStores[0].records;
      expect(recs).toEqual([{ key: 'k', value: { v: 5 } }]);
    });

    it('reads records from a Snappy-compressed .ldb block', async () => {
      const leveldbDir = profileIdbDir(tmp, 'https_z.com_0.indexeddb.leveldb');
      writeLevelDbSSTable(
        leveldbDir,
        [
          ...idbMetadata(1, 'https://z.com', 'd', 1, 'store'),
          idbDataRecord(1, 1, idbStringKey('c'), 'zipped'),
        ],
        true
      );

      const { readIndexedDbDatabases } =
        await import('../../main/domains/indexed-db-reader/native/indexeddb');
      const recs = readIndexedDbDatabases(leveldbDir)[0].objectStores[0].records;
      expect(recs).toEqual([{ key: 'c', value: 'zipped' }]);
    });
  });

  // ------------------------------------------------------------------
  // Snappy decompressor (unit)
  // ------------------------------------------------------------------
  describe('snappy decompression', () => {
    it('decompresses an all-literal block', () => {
      const out = snappyDecompressBlock(Uint8Array.from(snappyLiteralBlock([10, 20, 30])));
      expect(Array.from(out)).toEqual([10, 20, 30]);
    });

    it('decompresses a block with a one-byte copy back-reference', () => {
      // uncompressed length 8: literal "abcd" then copy(len=4, offset=4) → "abcdabcd".
      const block = [0x08, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x01, 0x04];
      const out = snappyDecompressBlock(Uint8Array.from(block));
      expect(Buffer.from(out).toString('ascii')).toBe('abcdabcd');
    });
  });
});
