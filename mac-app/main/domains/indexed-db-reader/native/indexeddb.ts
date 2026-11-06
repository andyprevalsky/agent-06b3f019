/**
 * Native Chrome IndexedDB decoder — the envelope/metadata/record layer.
 *
 * This is a faithful TypeScript port of the IndexedDB-specific decoding in
 * `ccl_chromium_reader.ccl_chromium_indexeddb` (the Python library the app
 * previously shelled out to). It sits on top of:
 *   - `./leveldb`             — the raw LevelDB physical-format reader
 *   - `./v8-deserializer`     — V8 structured-clone value decoder
 *   - `./blink-deserializer`  — Blink host-object (DOM type) decoder
 *
 * Together these replace the bundled `scripts/read_indexeddb.py` + the
 * `ccl_chromium_reader` pip dependency, so IndexedDB can be read with zero
 * runtime dependency on a system `python3` interpreter.
 *
 * Reference (byte layout): the Chromium LevelDB coding scheme
 * https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/docs/leveldb_coding_scheme.md
 */

import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '../../../../shared/utils/error';
import { KeyState, RawLevelDb, type LdbRecord } from './leveldb';
import { deserializeV8Value } from './v8-deserializer';
import {
  BLINK_TRAILER_OFFSET_TAG,
  BLINK_TRAILER_SIZE,
  BLINK_VERSION_TAG,
  bytesToHexKey,
  decodeTruncatedInt,
  decodeUtf16Be,
  IdbKey,
  KEY_REPLACE_WITH_BLOB,
  makePrefix,
  MIN_WIRE_FORMAT_VERSION_FOR_TRAILER,
  readExternalObject,
  readLeVarint,
  startsWith,
  type ExternalObject,
} from './idb-coding';
import { serializeKey, serializeValue } from './serialize';
import { SliceClock } from '../../../base/timeSlice';
import type { IndexedDBDatabase, IndexedDBObjectStore, IndexedDBRecord } from '../types';

// ---------------------------------------------------------------------------
// Database / object-store identity + metadata
// ---------------------------------------------------------------------------

interface DatabaseId {
  dbidNo: number;
  origin: string;
  name: string;
}

const GLOBAL_META_PREFIX = Uint8Array.from([0, 0, 0, 0]);
const DB_ID_KEY_PREFIX = Uint8Array.from([0, 0, 0, 0, 0xc9]);

/** Latest-wins record picker keyed by a string. Mirrors ccl's `reversed()` + seq compare. */
function pickLatest(
  records: LdbRecord[],
  keyOf: (r: LdbRecord) => string | null
): Map<string, LdbRecord> {
  const out = new Map<string, LdbRecord>();
  // ccl iterates reversed(); we iterate forward and keep highest seq, which is
  // equivalent for "newest version of a live key".
  for (const r of records) {
    if (r.state !== KeyState.Live) continue;
    const k = keyOf(r);
    if (k === null) continue;
    const existing = out.get(k);
    if (existing === undefined || existing.seq < r.seq) out.set(k, r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Native IndexedDb — caches raw records, resolves metadata, iterates records
// ---------------------------------------------------------------------------

interface DecodedRecord {
  key: IdbKey;
  value: unknown;
  isLive: boolean;
  seq: number;
}

class NativeIndexedDb {
  private readonly records: LdbRecord[];
  private readonly blobDir: string | null;
  private readonly dbIds: DatabaseId[];
  /** (dbId,storeId,metaType) → StoreName record etc. */
  private readonly objStoreMeta = new Map<string, LdbRecord>();
  private readonly dbMeta = new Map<string, LdbRecord>();
  private readonly blobLookup = new Map<string, ExternalObject>();

  constructor(records: LdbRecord[], blobDir: string | null) {
    this.blobDir = blobDir;
    this.records = records;
    this.dbIds = this.readGlobalMetadata();
    this.readDatabaseMetadata();
    this.readObjectStoreMetadata();
  }

  /** Read every raw record in one synchronous pass (tests / fidelity tooling). */
  static open(dir: string, blobDir: string | null): NativeIndexedDb {
    return new NativeIndexedDb([...new RawLevelDb(dir).iterateRecords()], blobDir);
  }

  /** Read the raw records in time slices so the main event loop keeps running. */
  static async openSliced(
    dir: string,
    blobDir: string | null,
    clock: SliceClock
  ): Promise<NativeIndexedDb> {
    const records: LdbRecord[] = [];
    for (const record of new RawLevelDb(dir).iterateRecords()) {
      records.push(record);
      if (clock.shouldYield()) await clock.yieldToEventLoop();
    }
    await clock.checkpoint();
    return new NativeIndexedDb(records, blobDir);
  }

  /** Global metadata → the set of databases. Mirrors `_get_raw_global_metadata` + `GlobalMetadata`. */
  private readGlobalMetadata(): DatabaseId[] {
    // Live newest records whose key starts with 00 00 00 00, keyed by full key.
    const meta = pickLatest(this.records, (r) =>
      startsWith(r.key, GLOBAL_META_PREFIX) ? bytesToHexKey(r.key) : null
    );
    const dbIds: DatabaseId[] = [];
    for (const rec of meta.values()) {
      if (!startsWith(rec.key, DB_ID_KEY_PREFIX)) continue;
      const body = rec.key.subarray(5);
      let o = 0;
      const originLen = readLeVarint(body, o);
      o += originLen.bytesRead;
      const origin = decodeUtf16Be(body.subarray(o, o + originLen.value * 2));
      o += originLen.value * 2;
      const nameLen = readLeVarint(body, o);
      o += nameLen.bytesRead;
      const name = decodeUtf16Be(body.subarray(o, o + nameLen.value * 2));
      const dbidNo = decodeTruncatedInt(rec.value);
      dbIds.push({ dbidNo, origin, name });
    }
    return dbIds;
  }

  /** Database metadata (we only need MaximumObjectStoreId). Mirrors `_get_raw_database_metadata`. */
  private readDatabaseMetadata(): void {
    for (const db of this.dbIds) {
      const prefix = makePrefix(db.dbidNo, 0, 0);
      for (const r of this.records) {
        if (r.state !== KeyState.Live || !startsWith(r.key, prefix)) continue;
        const metaType = r.key[prefix.length];
        const mapKey = `${db.dbidNo}:${metaType}`;
        const existing = this.dbMeta.get(mapKey);
        if (existing === undefined || existing.seq < r.seq) this.dbMeta.set(mapKey, r);
      }
    }
  }

  /** Object-store metadata (we need StoreName). Mirrors `_get_raw_object_store_metadata`. */
  private readObjectStoreMetadata(): void {
    for (const db of this.dbIds) {
      const prefix = makePrefix(db.dbidNo, 0, 0, [50]);
      for (const r of this.records) {
        if (r.state !== KeyState.Live || !startsWith(r.key, prefix)) continue;
        const after = r.key.subarray(prefix.length);
        const { value: objStoreId, bytesRead } = readLeVarint(after, 0);
        const metaType = r.key[prefix.length + bytesRead];
        const mapKey = `${db.dbidNo}:${objStoreId}:${metaType}`;
        const existing = this.objStoreMeta.get(mapKey);
        if (existing === undefined || existing.seq < r.seq) this.objStoreMeta.set(mapKey, r);
      }
    }
  }

  private maxObjectStoreId(dbId: number): number {
    // DatabaseMetadataType.MaximumObjectStoreId === 3
    const rec = this.dbMeta.get(`${dbId}:3`);
    return rec ? decodeTruncatedInt(rec.value) : 0;
  }

  private storeName(dbId: number, storeId: number): string | null {
    // ObjectStoreMetadataType.StoreName === 0
    const rec = this.objStoreMeta.get(`${dbId}:${storeId}:0`);
    return rec ? decodeUtf16Be(rec.value) : null;
  }

  /** The databases discovered in this folder. */
  get databases(): DatabaseId[] {
    return this.dbIds;
  }

  /** Object-store ids + names for a database. Object stores are enumerated from 1. */
  objectStores(dbId: number): { id: number; name: string }[] {
    const max = this.maxObjectStoreId(dbId);
    const out: { id: number; name: string }[] = [];
    for (let id = 1; id <= max; id++) {
      const name = this.storeName(dbId, id);
      out.push({ id, name: name ?? '' });
    }
    return out;
  }

  /** Build (and cache) the blob-info lookup for an object store. Mirrors `get_blob_info`. */
  private ensureBlobInfo(dbId: number, storeId: number): void {
    const prefix = makePrefix(dbId, storeId, 3);
    for (const r of this.records) {
      if (!startsWith(r.userKey, prefix)) continue;
      const rawKey = r.userKey.subarray(prefix.length);
      let o = 0;
      let idx = 0;
      while (o < r.value.length) {
        const { obj, offset } = readExternalObject(r.value, o);
        this.blobLookup.set(`${bytesToHexKey(rawKey)}:${idx}`, obj);
        o = offset;
        idx += 1;
      }
    }
  }

  private getBlobInfo(
    dbId: number,
    storeId: number,
    rawKey: Uint8Array,
    fileIndex: number
  ): ExternalObject | null {
    const lookupKey = `${bytesToHexKey(rawKey)}:${fileIndex}`;
    if (!this.blobLookup.has(lookupKey)) this.ensureBlobInfo(dbId, storeId);
    return this.blobLookup.get(lookupKey) ?? null;
  }

  private readBlobFile(dbId: number, info: ExternalObject): Uint8Array | null {
    if (this.blobDir === null) return null;
    const top = (Math.floor(info.blobNumber / 256) & 0xff).toString(16).padStart(2, '0');
    const p = path.join(this.blobDir, dbId.toString(16), top, info.blobNumber.toString(16));
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  /**
   * Peel the IndexedDB value envelope down to the raw V8 payload.
   * Mirrors `read_record_precursor` (handles kReplaceWithBlob + BlinkTrailer).
   * Returns the V8 payload bytes, or null if it could not be resolved.
   */
  private readRecordPrecursor(
    dbId: number,
    storeId: number,
    rawKey: Uint8Array,
    buffer: Uint8Array
  ): Uint8Array | null {
    let o = 0;
    if (buffer[o] !== BLINK_VERSION_TAG) return null; // Blink type tag not present
    o += 1;
    const blinkVersion = readLeVarint(buffer, o);
    o += blinkVersion.bytesRead;

    if (buffer[o] === KEY_REPLACE_WITH_BLOB) {
      o += 1;
      const blobSize = readLeVarint(buffer, o);
      o += blobSize.bytesRead;
      const blobIndex = readLeVarint(buffer, o);
      o += blobIndex.bytesRead;
      const info = this.getBlobInfo(dbId, storeId, rawKey, blobIndex.value);
      if (info === null) return null;
      const blob = this.readBlobFile(dbId, info);
      if (blob === null) return null;
      return this.readRecordPrecursor(dbId, storeId, rawKey, blob);
    }

    if (blinkVersion.value >= MIN_WIRE_FORMAT_VERSION_FOR_TRAILER) {
      if (buffer[o] !== BLINK_TRAILER_OFFSET_TAG) {
        throw new Error('Blink trailer does not start with kTrailerOffsetTag');
      }
      o += BLINK_TRAILER_SIZE;
    }

    return buffer.subarray(o);
  }

  /** Iterate decoded records of an object store. Mirrors `iterate_records`. */
  *iterateRecords(dbId: number, storeId: number): Generator<DecodedRecord> {
    const prefix = makePrefix(dbId, storeId, 1);
    for (const r of this.records) {
      if (!startsWith(r.key, prefix)) continue;
      const key = new IdbKey(r.key.subarray(prefix.length));
      const isLive = r.state === KeyState.Live;

      if (r.value.length === 0) {
        yield { key, value: null, isLive, seq: r.seq };
        continue;
      }

      // Per-record tolerance mirrors ccl's `bad_deserializer_data_handler`: a
      // single undecodable record (unsupported type, or an external value whose
      // blob file is missing) is skipped rather than aborting the store or
      // emitting a null-valued placeholder that would just add noise to the
      // synced payload.
      try {
        const valueVersion = readLeVarint(r.value, 0);
        const afterVersion = r.value.subarray(valueVersion.bytesRead);
        const v8Payload = this.readRecordPrecursor(dbId, storeId, key.rawKey, afterVersion);
        if (v8Payload === null) continue;
        const value = deserializeV8Value(v8Payload);
        yield { key, value, isLive, seq: r.seq };
      } catch {
        // Skip — undecodable value.
        continue;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

/**
 * Lower-level decode that yields the *raw* decoded key/value per record (before
 * JSON serialization), grouped by database/object-store. Exposed for
 * validation/tests that compare decoding fidelity against a reference decoder;
 * production code uses {@link readIndexedDbDatabases}.
 */
export function readDecodedDatabases(
  dir: string,
  blobDir?: string
): {
  name: string;
  stores: { name: string; records: { key: IdbKey['value']; value: unknown }[] }[];
}[] {
  const idb = NativeIndexedDb.open(dir, blobDir ?? null);
  return idb.databases.map((db) => ({
    name: db.name,
    stores: idb.objectStores(db.dbidNo).map((store) => {
      const records: { key: IdbKey['value']; value: unknown }[] = [];
      for (const rec of idb.iterateRecords(db.dbidNo, store.id)) {
        records.push({ key: rec.key.value, value: rec.value });
      }
      return { name: store.name, records };
    }),
  }));
}

/**
 * Decode every database → object store → record, yielding once per record so
 * a driver can decide whether to hand the event loop back. Returns the result.
 */
function* decodeDatabases(idb: NativeIndexedDb): Generator<void, IndexedDBDatabase[]> {
  const databases: IndexedDBDatabase[] = [];
  for (const db of idb.databases) {
    const objectStores: IndexedDBObjectStore[] = [];
    for (const store of idb.objectStores(db.dbidNo)) {
      const records: IndexedDBRecord[] = [];
      try {
        for (const rec of idb.iterateRecords(db.dbidNo, store.id)) {
          try {
            records.push({ key: serializeKey(rec.key), value: serializeValue(rec.value) });
          } catch (err) {
            records.push({ key: '', value: null, error: getErrorMessage(err) });
          }
          yield;
        }
      } catch (err) {
        const error = `Failed to iterate records: ${getErrorMessage(err)}`;
        records.push({ key: '', value: null, error });
      }
      objectStores.push({ name: store.name, records });
    }
    databases.push({ name: db.name, objectStores });
  }
  return databases;
}

/** Synchronous decode: holds the calling thread for the whole folder (tests / tooling only). */
export function readIndexedDbDatabases(dir: string, blobDir?: string): IndexedDBDatabase[] {
  const decoding = decodeDatabases(NativeIndexedDb.open(dir, blobDir ?? null));
  for (;;) {
    const step = decoding.next();
    if (step.done === true) return step.value;
  }
}

/**
 * Same output as {@link readIndexedDbDatabases}, decoded in time slices of
 * `clock`'s budget so the Electron main process keeps serving input, IPC and
 * window events while a large IndexedDB folder is scanned.
 */
export async function readIndexedDbDatabasesSliced(
  dir: string,
  blobDir: string | undefined,
  clock: SliceClock = new SliceClock()
): Promise<IndexedDBDatabase[]> {
  const decoding = decodeDatabases(await NativeIndexedDb.openSliced(dir, blobDir ?? null, clock));
  for (;;) {
    const step = decoding.next();
    if (step.done === true) return step.value;
    if (clock.shouldYield()) await clock.yieldToEventLoop();
  }
}
