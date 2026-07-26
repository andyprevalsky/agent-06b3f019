/**
 * Low-level Chromium IndexedDB byte coding: varints, UTF-16BE strings, the
 * primary-key (`IdbKey`) decoder, external-object (Blob/File) metadata, the
 * Blink value-envelope constants, and the (db_id, object_store_id, index_id)
 * key-prefix encoding. Extracted from `indexeddb.ts` so each module stays small.
 *
 * Reference: the Chromium LevelDB coding scheme
 * https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/docs/leveldb_coding_scheme.md
 */

// ---------------------------------------------------------------------------
// Byte-cursor helpers (mirror ccl's stream-based varint / int decoding)
// ---------------------------------------------------------------------------

/** Result of reading a little-endian base-128 varint. */
export interface Varint {
  value: number;
  bytesRead: number;
}

/**
 * Read an unsigned little-endian base-128 varint starting at `offset`.
 * Mirrors ccl's `_le_varint_from_bytes` (max 10 groups → 64-bit).
 */
export function readLeVarint(buf: Uint8Array, offset: number): Varint {
  let result = 0;
  let shift = 0;
  let i = 0;
  while (i < 10) {
    const b = buf[offset + i];
    if (b === undefined) {
      throw new Error('readLeVarint: ran out of bytes');
    }
    // Use multiplication rather than `<<` so values above 2^31 stay exact.
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    i += 1;
    if ((b & 0x80) === 0) break;
  }
  return { value: result, bytesRead: i };
}

/**
 * "Dumb" little-endian integer used by Chromium's `EncodeInt` — writes bytes
 * LE until no more 1-bits; the decoder must already know the length. Mirrors
 * ccl's `decode_truncated_int`.
 */
export function decodeTruncatedInt(buf: Uint8Array): number {
  if (buf.length === 0) throw new Error('decodeTruncatedInt: no data to decode');
  let result = 0;
  for (let i = 0; i < buf.length; i++) {
    result += buf[i] * Math.pow(2, i * 8);
  }
  return result;
}

/** Decode UTF-16 big-endian bytes (Chromium stores strings this way in keys). */
export function decodeUtf16Be(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
  }
  return out;
}

export function startsWith(haystack: Uint8Array, prefix: Uint8Array): boolean {
  if (haystack.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (haystack[i] !== prefix[i]) return false;
  }
  return true;
}

export function bytesToHexKey(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

// ---------------------------------------------------------------------------
// IdbKey — the decoded primary key of a record
// ---------------------------------------------------------------------------

enum IdbKeyType {
  Null = 0,
  String = 1,
  Date = 2,
  Number = 3,
  Array = 4,
  MinKey = 5,
  Binary = 6,
}

/** Serialized form of a decoded IndexedDB key (matches `IndexedDBRecord.key`). */
export type SerializedIdbKey = string | number | (string | number)[];

/**
 * Decode one IndexedDB key from `buffer` (which may be an inner key inside an
 * array key). Mirrors ccl's `IdbKey`. `rawLength` is how many bytes this key
 * consumed, so array keys can advance the cursor.
 */
export class IdbKey {
  readonly keyType: IdbKeyType;
  readonly value: null | number | Date | Uint8Array | string | IdbKey[];
  readonly rawLength: number;
  readonly rawKey: Uint8Array;

  constructor(buffer: Uint8Array) {
    this.keyType = buffer[0] as IdbKeyType;
    const rest = buffer.subarray(1);

    switch (this.keyType) {
      case IdbKeyType.Null: {
        this.value = null;
        this.rawLength = 1;
        break;
      }
      case IdbKeyType.String: {
        const { value: strLen, bytesRead } = readLeVarint(rest, 0);
        this.value = decodeUtf16Be(rest.subarray(bytesRead, bytesRead + strLen * 2));
        this.rawLength = 1 + bytesRead + strLen * 2;
        break;
      }
      case IdbKeyType.Date: {
        const ms = new DataView(rest.buffer, rest.byteOffset, 8).getFloat64(0, true);
        this.value = new Date(ms);
        this.rawLength = 9;
        break;
      }
      case IdbKeyType.Number: {
        this.value = new DataView(rest.buffer, rest.byteOffset, 8).getFloat64(0, true);
        this.rawLength = 9;
        break;
      }
      case IdbKeyType.Array: {
        const { value: count, bytesRead } = readLeVarint(rest, 0);
        let cursor = rest.subarray(bytesRead);
        const items: IdbKey[] = [];
        let raw = 1 + bytesRead;
        for (let i = 0; i < count; i++) {
          const inner = new IdbKey(cursor);
          cursor = cursor.subarray(inner.rawLength);
          raw += inner.rawLength;
          items.push(inner);
        }
        this.value = items;
        this.rawLength = raw;
        break;
      }
      case IdbKeyType.Binary: {
        const { value: binLen, bytesRead } = readLeVarint(rest, 0);
        this.value = rest.subarray(bytesRead, bytesRead + binLen);
        this.rawLength = 1 + bytesRead + binLen;
        break;
      }
      default:
        // MinKey (5) has no stored value in Chromium and never appears as a
        // record's primary key; anything else is malformed.
        throw new Error(`Unsupported IdbKey type ${String(this.keyType)}`);
    }

    this.rawKey = buffer.subarray(0, this.rawLength);
  }
}

// ---------------------------------------------------------------------------
// External object (Blob / File) metadata
// ---------------------------------------------------------------------------

enum ExternalObjectType {
  Blob = 0,
  File = 1,
  NativeFileSystemHandle = 2,
}

export interface ExternalObject {
  objectType: ExternalObjectType;
  blobNumber: number;
  mimeType: string | null;
  size: number | null;
  fileName: string | null;
}

/** Parse one `IndexedDBExternalObject` from `buf` at `offset`. Returns the object + new offset. */
export function readExternalObject(
  buf: Uint8Array,
  offset: number
): { obj: ExternalObject; offset: number } {
  let o = offset;
  const blobType = buf[o] as ExternalObjectType;
  o += 1;
  if (blobType !== ExternalObjectType.Blob && blobType !== ExternalObjectType.File) {
    throw new Error(`Unsupported external object type ${String(blobType)}`);
  }
  const blobNumber = readLeVarint(buf, o);
  o += blobNumber.bytesRead;
  const mimeLen = readLeVarint(buf, o);
  o += mimeLen.bytesRead;
  const mimeType = decodeUtf16Be(buf.subarray(o, o + mimeLen.value * 2));
  o += mimeLen.value * 2;
  const dataSize = readLeVarint(buf, o);
  o += dataSize.bytesRead;

  if (blobType === ExternalObjectType.File) {
    const nameLen = readLeVarint(buf, o);
    o += nameLen.bytesRead;
    const fileName = decodeUtf16Be(buf.subarray(o, o + nameLen.value * 2));
    o += nameLen.value * 2;
    const lastModified = readLeVarint(buf, o); // microseconds since 1601 — consumed, not surfaced
    o += lastModified.bytesRead;
    return {
      obj: {
        objectType: blobType,
        blobNumber: blobNumber.value,
        mimeType,
        size: dataSize.value,
        fileName,
      },
      offset: o,
    };
  }

  return {
    obj: {
      objectType: blobType,
      blobNumber: blobNumber.value,
      mimeType,
      size: dataSize.value,
      fileName: null,
    },
    offset: o,
  };
}

// ---------------------------------------------------------------------------
// Blink envelope constants
// ---------------------------------------------------------------------------

export const BLINK_VERSION_TAG = 0xff; // kVersionTag
export const BLINK_TRAILER_OFFSET_TAG = 0xfe; // kTrailerOffsetTag
export const BLINK_TRAILER_SIZE = 13; // tag(1) + offset(u64 BE) + length(u32 BE)
export const MIN_WIRE_FORMAT_VERSION_FOR_TRAILER = 21;
export const KEY_REPLACE_WITH_BLOB = 0x01; // idb_value_wrapping.cc kReplaceWithBlob

// ---------------------------------------------------------------------------
// Prefix (db_id / object_store_id / index_id) encoding
// ---------------------------------------------------------------------------

function countBytes(val: number): number {
  if (val === 0) return 1;
  let i = 0;
  let v = val;
  while (v > 0) {
    i += 1;
    v = Math.floor(v / 256);
  }
  return i;
}

function leBytes(val: number): number[] {
  if (val < 0) throw new Error('leBytes: negative');
  if (val === 0) return [0];
  const out: number[] = [];
  let v = val;
  while (v > 0) {
    out.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}

/** Build the key prefix for (db_id, obj_store_id, index_id) plus optional suffix. Mirrors `make_prefix`. */
export function makePrefix(
  dbId: number,
  objStoreId: number,
  indexId: number,
  end: number[] = []
): Uint8Array {
  const dbSize = countBytes(dbId);
  const osSize = countBytes(objStoreId);
  const idxSize = countBytes(indexId);
  if (dbSize > 8 || osSize > 8 || idxSize > 4) throw new Error('make_prefix: id sizes too big');
  const byteOne = ((dbSize - 1) << 5) | ((osSize - 1) << 2) | (idxSize - 1);
  return Uint8Array.from([
    byteOne,
    ...leBytes(dbId),
    ...leBytes(objStoreId),
    ...leBytes(indexId),
    ...end,
  ]);
}
