/**
 * Pure-TypeScript port of CCL Forensics' `ccl_leveldb` physical-format reader.
 *
 * Faithful 1:1 reimplementation of the LevelDB on-disk parser: table (`.ldb` /
 * `.sst`) files and write-ahead log (`.log`) files, down to block restart
 * arrays, prefix-compressed entries, the table footer, CRC-tagged log blocks,
 * and per-batch WriteBatch parsing. Snappy-compressed table blocks are inflated
 * via `snappyDecompressBlock`.
 *
 * `RawLevelDb.iterateRecords()` mirrors ccl's `iterate_records_raw` — every
 * record across every data file, in ascending file-number order, pre-merge
 * (deleted tombstones and superseded duplicates included).
 *
 * Reference:
 *   ccl_chromium_reader.storage_formats.ccl_leveldb
 *   https://github.com/google/leveldb/blob/master/doc/table_format.md
 */

import fs from 'fs';
import path from 'path';
import { snappyDecompressBlock } from './snappy';

/**
 * Whether a key is a live Put, a Delete tombstone, or of indeterminate state.
 * Mirrors ccl `KeyState`: an `.ldb` internal key shorter than the 8-byte
 * trailer boundary carries no type byte, so its state is `Unknown`.
 */
export enum KeyState {
  Live = 'Live',
  Deleted = 'Deleted',
  Unknown = 'Unknown',
}

/** Which physical file kind a record came from. */
export type FileType = 'Ldb' | 'Log';

/** One raw record decoded from a LevelDB data file. */
export interface LdbRecord {
  /**
   * The raw key exactly as ccl `Record.key`: for `.ldb` records this INCLUDES
   * the trailing 8-byte internal-key trailer; for `.log` records it's the plain
   * user key.
   */
  key: Uint8Array;
  /**
   * ccl `Record.user_key`: for `.ldb`, `key[:-8]` when `key.length >= 8` else
   * `key`; for `.log`, equal to `key`.
   */
  userKey: Uint8Array;
  value: Uint8Array;
  seq: number;
  state: KeyState;
  fileType: FileType;
  originFile: string;
}

/** Sequential + seekable byte cursor over a file/block buffer. */
class BinaryReader {
  private pos: number;

  constructor(
    private readonly data: Uint8Array,
    start = 0
  ) {
    this.pos = start;
  }

  tell(): number {
    return this.pos;
  }

  /** Read `count` bytes forward; returns however many remain if short. */
  read(count: number): Uint8Array {
    const end = Math.min(this.pos + count, this.data.length);
    const out = this.data.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  /** One byte, or `null` at end-of-data. */
  readByte(): number | null {
    if (this.pos >= this.data.length) return null;
    return this.data[this.pos++];
  }

  /**
   * Unsigned LE base-128 varint (mirrors `_read_le_varint`). `is32` caps the
   * group count at 5 (Google's 32-bit varints) versus 10 (64-bit). Returns
   * `null` at end-of-data.
   */
  readVarint(is32 = false): number | null {
    const limit = is32 ? 5 : 10;
    let result = 0;
    let i = 0;
    while (i < limit) {
      const raw = this.readByte();
      if (raw === null) return null;
      // Multiplication (not <<) keeps values above 31 bits exact.
      result += (raw & 0x7f) * Math.pow(2, i * 7);
      if ((raw & 0x80) === 0) break;
      i += 1;
    }
    return result;
  }
}

/** Unsigned LE uint32 at `offset` within `data`. */
function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

/** Unsigned LE uint64 at `offset` as a BigInt. */
function readUint64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i]);
  }
  return value;
}

/** Concatenate two byte spans into a fresh `Uint8Array`. */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Offset + length of a block within a table file. */
interface BlockHandle {
  offset: number;
  length: number;
}

/** Read a BlockHandle (two varints) from the reader's current position. */
function readBlockHandle(reader: BinaryReader): BlockHandle {
  const offset = reader.readVarint() ?? 0;
  const length = reader.readVarint() ?? 0;
  return { offset, length };
}

/** Read a BlockHandle from a standalone byte span. */
function blockHandleFromBytes(data: Uint8Array): BlockHandle {
  return readBlockHandle(new BinaryReader(data));
}

/** A single prefix-decoded entry within a table block. */
interface RawBlockEntry {
  key: Uint8Array;
  value: Uint8Array;
}

/**
 * A decompressed table block. Parses the trailing restart array and yields
 * prefix-compressed entries from the first restart point onward.
 */
class Block {
  private readonly restartArrayOffset: number;

  constructor(private readonly raw: Uint8Array) {
    const restartArrayCount = readUint32LE(this.raw, this.raw.length - 4);
    this.restartArrayOffset = this.raw.length - (restartArrayCount + 1) * 4;
  }

  private getFirstEntryOffset(): number {
    // Restart offsets are always non-negative in-bounds indices, so the
    // unsigned read matches ccl's signed `<i` read byte-for-byte.
    return readUint32LE(this.raw, this.restartArrayOffset);
  }

  *entries(): Generator<RawBlockEntry> {
    const reader = new BinaryReader(this.raw, this.getFirstEntryOffset());
    let key: Uint8Array = new Uint8Array(0);

    while (reader.tell() < this.restartArrayOffset) {
      const sharedLength = reader.readVarint(true) ?? 0;
      const nonSharedLength = reader.readVarint(true) ?? 0;
      const valueLength = reader.readVarint(true) ?? 0;

      if (sharedLength > key.length) {
        throw new Error('Block: shared key length is larger than the previous key');
      }

      const nonShared = reader.read(nonSharedLength);
      key = concatBytes(key.subarray(0, sharedLength), nonShared);
      const value = reader.read(valueLength);

      yield { key: key.slice(), value: value.slice() };
    }
  }
}

const BLOCK_TRAILER_SIZE = 5;
const FOOTER_SIZE = 48;
const TABLE_MAGIC = 0xdb4775248b80fb57n;

/** A LevelDB table (`.ldb` / `.sst`) file. */
class LdbFile {
  private readonly indexHandle: BlockHandle;
  private readonly index: Array<{ key: Uint8Array; handle: BlockHandle }>;

  constructor(
    private readonly data: Uint8Array,
    private readonly fileName: string
  ) {
    // Footer: [metaindex handle][index handle][padding][8-byte magic].
    const footer = new BinaryReader(this.data, this.data.length - FOOTER_SIZE);
    readBlockHandle(footer); // metaindex handle (unused for record iteration)
    this.indexHandle = readBlockHandle(footer);

    const magic = readUint64LE(this.data, this.data.length - 8);
    if (magic !== TABLE_MAGIC) {
      throw new Error(`Invalid magic number in ${this.fileName}`);
    }

    this.index = this.readIndex();
  }

  private readBlock(handle: BlockHandle): Block {
    const rawBlock = this.data.subarray(handle.offset, handle.offset + handle.length);
    const trailerStart = handle.offset + handle.length;
    const trailer = this.data.subarray(trailerStart, trailerStart + BLOCK_TRAILER_SIZE);

    if (rawBlock.length !== handle.length || trailer.length !== BLOCK_TRAILER_SIZE) {
      throw new Error(
        `Could not read all of the block at offset ${handle.offset} in file ${this.fileName}`
      );
    }

    const isCompressed = trailer[0] !== 0;
    const blockBytes = isCompressed ? snappyDecompressBlock(rawBlock) : rawBlock;
    return new Block(blockBytes);
  }

  private readIndex(): Array<{ key: Uint8Array; handle: BlockHandle }> {
    const indexBlock = this.readBlock(this.indexHandle);
    const out: Array<{ key: Uint8Array; handle: BlockHandle }> = [];
    for (const entry of indexBlock.entries()) {
      out.push({ key: entry.key, handle: blockHandleFromBytes(entry.value) });
    }
    return out;
  }

  *records(): Generator<LdbRecord> {
    for (const { handle } of this.index) {
      const block = this.readBlock(handle);
      for (const entry of block.entries()) {
        yield ldbRecord(entry.key, entry.value, this.fileName);
      }
    }
  }
}

/**
 * Build a table record from a raw internal key. The 8-byte trailer packs
 * `(seq << 8) | type`; type byte 0 = Deleted, otherwise Live. A key not longer
 * than the trailer carries no type byte, so its state is `Unknown` (ccl).
 */
function ldbRecord(key: Uint8Array, value: Uint8Array, originFile: string): LdbRecord {
  const trailer = readUint64LE(key, key.length - 8);
  const seq = Number(trailer >> 8n);
  let state: KeyState;
  if (key.length > 8) {
    // key[-8] is the value type byte (0 = delete).
    state = key[key.length - 8] === 0 ? KeyState.Deleted : KeyState.Live;
  } else {
    state = KeyState.Unknown;
  }
  // ccl Record.user_key: strip the trailer only when key.length >= 8.
  const userKey = key.length < 8 ? key : key.subarray(0, key.length - 8);
  return { key, userKey, value, seq, state, fileType: 'Ldb', originFile };
}

const LOG_BLOCK_SIZE = 32768;

/** Log physical record fragment types. */
const enum LogEntryType {
  Zero = 0,
  Full = 1,
  First = 2,
  Middle = 3,
  Last = 4,
}

/** A LevelDB write-ahead log (`.log`) file. */
class LogFile {
  constructor(
    private readonly data: Uint8Array,
    private readonly fileName: string
  ) {}

  /** Reassemble fragmented physical records into full WriteBatch payloads. */
  private *batches(): Generator<Uint8Array> {
    let inRecord = false;
    let block: Uint8Array = new Uint8Array(0);

    const blockCount = Math.ceil(this.data.length / LOG_BLOCK_SIZE) || 0;
    for (let idx = 0; idx < blockCount; idx++) {
      const chunkStart = idx * LOG_BLOCK_SIZE;
      const chunkEnd = Math.min(chunkStart + LOG_BLOCK_SIZE, this.data.length);
      const reader = new BinaryReader(this.data.subarray(chunkStart, chunkEnd));

      while (reader.tell() < LOG_BLOCK_SIZE - 6) {
        const header = reader.read(7);
        if (header.length < 7) break;
        // header: crc(uint32) | length(uint16) | block_type(uint8)
        const length = header[4] | (header[5] << 8);
        const blockType = header[6];

        if (blockType === LogEntryType.Full) {
          if (inRecord) {
            throw new Error(`Full block whilst still building a block in ${this.fileName}`);
          }
          yield reader.read(length).slice();
        } else if (blockType === LogEntryType.First) {
          if (inRecord) {
            throw new Error(`First block whilst still building a block in ${this.fileName}`);
          }
          block = reader.read(length).slice();
          inRecord = true;
        } else if (blockType === LogEntryType.Middle) {
          if (!inRecord) {
            throw new Error(`Middle block whilst not building a block in ${this.fileName}`);
          }
          block = concatBytes(block, reader.read(length));
        } else if (blockType === LogEntryType.Last) {
          if (!inRecord) {
            throw new Error(`Last block whilst not building a block in ${this.fileName}`);
          }
          block = concatBytes(block, reader.read(length));
          inRecord = false;
          yield block;
        } else {
          throw new Error(`Unknown log block type ${blockType} in ${this.fileName}`);
        }
      }
    }
  }

  *records(): Generator<LdbRecord> {
    for (const batch of this.batches()) {
      // WriteBatch header: seq(uint64) | count(uint32), then count entries of
      // type(uint8) | keyLen(varint32) | key | [valueLen(varint32) | value].
      const reader = new BinaryReader(batch);
      const header = reader.read(12);
      const seq = readUint64LE(header, 0);
      const count = readUint32LE(header, 8);

      for (let i = 0; i < count; i++) {
        const typeByte = reader.readByte();
        if (typeByte === null) break;
        const state = typeByte === 0 ? KeyState.Deleted : KeyState.Live;

        const keyLength = reader.readVarint(true) ?? 0;
        const key = reader.read(keyLength).slice();

        let value: Uint8Array;
        if (state !== KeyState.Deleted) {
          const valueLength = reader.readVarint(true) ?? 0;
          value = reader.read(valueLength).slice();
        } else {
          value = new Uint8Array(0);
        }

        yield {
          key,
          // ccl Record.user_key for a log record is the plain key itself.
          userKey: key,
          value,
          seq: Number(seq + BigInt(i)),
          state,
          fileType: 'Log',
          originFile: this.fileName,
        };
      }
    }
  }
}

/** Files whose basenames are LevelDB data files (six hex digits + suffix). */
const DATA_FILE_PATTERN = /^[0-9]{6}\.(ldb|log|sst)$/i;

/** A parsed record source with its numeric file id (for ordering). */
interface RecordSource {
  fileNo: number;
  records(): Generator<LdbRecord>;
}

/**
 * Reads every record from a Chrome IndexedDB LevelDB directory at the physical
 * format level, mirroring ccl's `RawLevelDb.iterate_records_raw`.
 */
export class RawLevelDb {
  private readonly sources: RecordSource[] = [];

  constructor(dir: string) {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      const match = DATA_FILE_PATTERN.exec(name);
      if (!match) continue;

      const filePath = path.join(dir, name);
      if (!fs.statSync(filePath).isFile()) continue;

      const stem = path.parse(name).name;
      const fileNo = parseInt(stem, 16);
      const suffix = match[1].toLowerCase();
      // Read each file only when iteration reaches it, so a time-sliced caller
      // never reads and parses the whole database in one synchronous step.
      this.sources.push({
        fileNo,
        records: function* (): Generator<LdbRecord> {
          const data = new Uint8Array(fs.readFileSync(filePath));
          yield* suffix === 'log'
            ? new LogFile(data, name).records()
            : new LdbFile(data, name).records();
        },
      });
    }
  }

  /** Iterate every record across all data files, ascending by file number. */
  *iterateRecords(): Generator<LdbRecord> {
    const ordered = [...this.sources].sort((a, b) => a.fileNo - b.fileNo);
    for (const source of ordered) {
      yield* source.records();
    }
  }
}
