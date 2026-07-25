/**
 * Low-level byte-reader primitives for the V8 structured-clone deserializer.
 *
 * `V8ReaderBase` holds the stateless-format machinery of CCL Forensics'
 * `ccl_v8_value_deserializer.Deserializer`: the byte cursor, header read, LE
 * varints (incl. the 32-bit cap and zigzag decode), host-byte-order doubles,
 * BigInt digit decoding, the three string encodings, and the padding-skipping
 * tag stream with its EOF sentinel. The structured readers (objects, arrays,
 * maps, sets, typed-array views, host objects, the reference table) live in the
 * `Deserializer` subclass in `v8-deserializer.ts`.
 *
 * This split is purely organisational — every primitive here mirrors the
 * reference byte-for-byte and is validated against `ccl` on real Chrome data.
 */

/** Sentinel for V8 `undefined` / the-hole oddballs. */
export class V8Undefined {
  public readonly __type = 'Undefined' as const;
}

/** Single shared instance — the reference uses one `_Undefined()` too. */
export const UNDEFINED = new V8Undefined();

/** Descriptor for a `token_kSharedObject` — a HeapObject shared across isolates. */
export interface V8SharedObject {
  readonly __type: 'SharedObject';
  readonly id: number;
}

/** Descriptor for a `token_kRegExp`. Mirrors the reference: pattern only. */
export interface V8RegExp {
  readonly __type: 'RegExp';
  readonly source: string;
}

/** V8 serialization tag byte codes (see reference `Constants`). */
export const Tag = {
  kVersion: 0xff,
  kPadding: 0x00,
  kVerifyObjectCount: 0x3f, // '?'
  kTheHole: 0x2d, // '-'
  kUndefined: 0x5f, // '_'
  kNull: 0x30, // '0'
  kTrue: 0x54, // 'T'
  kFalse: 0x46, // 'F'
  kInt32: 0x49, // 'I'
  kUint32: 0x55, // 'U'
  kDouble: 0x4e, // 'N'
  kBigInt: 0x5a, // 'Z'
  kUtf8String: 0x53, // 'S'
  kOneByteString: 0x22, // '"'
  kTwoByteString: 0x63, // 'c'
  kObjectReference: 0x5e, // '^'
  kBeginJSObject: 0x6f, // 'o'
  kEndJSObject: 0x7b, // '{'
  kBeginSparseJSArray: 0x61, // 'a'
  kEndSparseJSArray: 0x40, // '@'
  kBeginDenseJSArray: 0x41, // 'A'
  kEndDenseJSArray: 0x24, // '$'
  kDate: 0x44, // 'D'
  kTrueObject: 0x79, // 'y'
  kFalseObject: 0x78, // 'x'
  kNumberObject: 0x6e, // 'n'
  kBigIntObject: 0x7a, // 'z'
  kStringObject: 0x73, // 's'
  kRegExp: 0x52, // 'R'
  kBeginJSMap: 0x3b, // ';'
  kEndJSMap: 0x3a, // ':'
  kBeginJSSet: 0x27, // "'"
  kEndJSSet: 0x2c, // ','
  kArrayBuffer: 0x42, // 'B'
  kArrayBufferTransfer: 0x74, // 't'
  kArrayBufferView: 0x56, // 'V'
  kSharedArrayBuffer: 0x75, // 'u'
  kSharedObject: 0x70, // 'p'
  kWasmModuleTransfer: 0x77, // 'w'
  kHostObject: 0x5c, // '\\'
  kWasmMemoryTransfer: 0x6d, // 'm'
  kError: 0x72, // 'r'
} as const;

/**
 * One element reader for an ArrayBufferView subtag. `size` is the element byte
 * width; `read` decodes one element at `off` from a little-endian `DataView`.
 * Mirrors the reference's `ArrayBufferViewTag.STRUCT_LOOKUP` (`struct` formats).
 */
export interface ViewElementSpec {
  readonly size: number;
  readonly read: (dv: DataView, off: number, littleEndian: boolean) => number | bigint | Uint8Array;
}

/** Subtag char code -> element spec. Mirrors `ArrayBufferViewTag`. */
export const VIEW_ELEMENT_SPECS: Readonly<Record<number, ViewElementSpec>> = {
  0x62: { size: 1, read: (dv, o): number => dv.getInt8(o) }, // 'b' Int8
  0x42: { size: 1, read: (dv, o): number => dv.getUint8(o) }, // 'B' Uint8
  0x43: { size: 1, read: (dv, o): number => dv.getUint8(o) }, // 'C' Uint8Clamped
  0x77: { size: 2, read: (dv, o, le): number => dv.getInt16(o, le) }, // 'w' Int16
  0x57: { size: 2, read: (dv, o, le): number => dv.getUint16(o, le) }, // 'W' Uint16
  0x64: { size: 4, read: (dv, o, le): number => dv.getInt32(o, le) }, // 'd' Int32
  0x44: { size: 4, read: (dv, o, le): number => dv.getUint32(o, le) }, // 'D' Uint32
  0x66: { size: 4, read: (dv, o, le): number => dv.getFloat32(o, le) }, // 'f' Float32
  0x46: { size: 8, read: (dv, o, le): number => dv.getFloat64(o, le) }, // 'F' Float64
  0x71: { size: 8, read: (dv, o, le): bigint => dv.getBigInt64(o, le) }, // 'q' BigInt64
  0x51: { size: 8, read: (dv, o, le): bigint => dv.getBigUint64(o, le) }, // 'Q' BigUint64
  // '?' DataView: reference unpacks with struct 'c' -> tuple of length-1 bytes.
  0x3f: { size: 1, read: (dv, o): Uint8Array => new Uint8Array([dv.getUint8(o)]) },
};

/** Sentinel returned by `readTag`/`peekTag` at end-of-stream (mirrors `b''`). */
export const EOF = -1;

const UTF8_DECODER = new TextDecoder('utf-8');
const UTF16LE_DECODER = new TextDecoder('utf-16le');

/**
 * Byte-cursor + primitive-format base for the V8 `Deserializer`. The header is
 * read in the constructor (faithful to ccl, which reads it in `__init__`).
 */
export class V8ReaderBase {
  private readonly data: Uint8Array;
  private readonly dv: DataView;
  protected readonly littleEndian: boolean;
  private readonly pointerSize: number;
  private pos = 0;

  /** The V8 wire-format version read from the header. */
  public readonly version: number;

  constructor(data: Uint8Array, opts?: { isLittleEndian?: boolean; is64bit?: boolean }) {
    this.data = data;
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.littleEndian = opts?.isLittleEndian ?? true;
    this.pointerSize = (opts?.is64bit ?? true) ? 8 : 4;
    this.version = this.readHeader();
  }

  /** Current read offset (bytes consumed). */
  public get position(): number {
    return this.pos;
  }

  // -------------------------------------------------------------------------
  // Low-level primitives (public — exposed for the Blink host-object delegate)
  // -------------------------------------------------------------------------

  /** Read one raw byte, advancing the cursor. */
  public readByte(): number {
    if (this.pos >= this.data.length) {
      throw new Error(`Could not read byte at offset ${String(this.pos)}; past end of data`);
    }
    const b = this.data[this.pos];
    this.pos += 1;
    return b;
  }

  /** Read exactly `length` raw bytes (a copy), advancing the cursor. */
  public readRawBytes(length: number): Uint8Array {
    const start = this.pos;
    if (start + length > this.data.length) {
      throw new Error(
        `Could not read all data at offset ${String(start)}; wanted ${String(length)}; ` +
          `got ${String(Math.max(0, this.data.length - start))}`
      );
    }
    const out = this.data.slice(start, start + length);
    this.pos = start + length;
    return out;
  }

  /**
   * Read an unsigned little-endian base-128 varint as a bigint. `is32bit`
   * caps the byte count at 5 (mirrors `read_le_varint(is_32bit=True)`); the
   * accumulation itself is identical.
   */
  public readVarintBig(is32bit = false): bigint {
    const limit = is32bit ? 5 : 10;
    let result = 0n;
    let i = 0;
    while (i < limit) {
      const b = this.readByte();
      result |= BigInt(b & 0x7f) << BigInt(i * 7);
      if ((b & 0x80) === 0) break;
      i += 1;
    }
    return result;
  }

  /** Read an unsigned LE varint as a `number` (used for lengths/uint32). */
  public readVarint(is32bit = false): number {
    return Number(this.readVarintBig(is32bit));
  }

  /** Alias mirroring the suggested contract; a uint32 is a plain LE varint. */
  public readUint32(): number {
    return this.readVarint();
  }

  /** Read a uint64 as a bigint (plain LE varint, no byte cap). */
  public readUint64(): bigint {
    return this.readVarintBig();
  }

  /** Read a UTF-8 string prefixed by a 32-bit varint length (Blink helper). */
  public readUtf8StringVarint32(): string {
    const length = this.readVarint(true);
    return UTF8_DECODER.decode(this.readRawBytes(length));
  }

  // -------------------------------------------------------------------------
  // Header + scalar readers (protected — used by the structured subclass)
  // -------------------------------------------------------------------------

  private readHeader(): number {
    const tag = this.readTag();
    if (tag !== Tag.kVersion) {
      throw new Error("Didn't get version tag in the header");
    }
    return this.readVarint();
  }

  protected readZigzag(): number {
    const unsigned = this.readVarintBig();
    if ((unsigned & 1n) === 1n) {
      return Number(-(unsigned >> 1n));
    }
    return Number(unsigned >> 1n);
  }

  protected readDouble(): number {
    const start = this.pos;
    if (start + 8 > this.data.length) {
      throw new Error(`Could not read all data at offset ${String(start)}; wanted 8`);
    }
    const value = this.dv.getFloat64(start, this.littleEndian);
    this.pos = start + 8;
    return value;
  }

  protected readBigInt(): bigint {
    const sizeFlag = this.readVarint();
    const isNeg = (sizeFlag & 0x01) === 1;
    const size = sizeFlag >> 4;
    const raw = this.readRawBytes(size * this.pointerSize);
    // int.from_bytes(raw, "little" | "big", signed=False)
    let value = 0n;
    if (this.littleEndian) {
      for (let i = raw.length - 1; i >= 0; i -= 1) {
        value = (value << 8n) | BigInt(raw[i]);
      }
    } else {
      for (let i = 0; i < raw.length; i += 1) {
        value = (value << 8n) | BigInt(raw[i]);
      }
    }
    return isNeg ? -value : value;
  }

  protected readUtf8String(): string {
    const length = this.readVarint();
    return UTF8_DECODER.decode(this.readRawBytes(length));
  }

  protected readOneByteString(): string | Uint8Array {
    const length = this.readVarint();
    const raw = this.readRawBytes(length);
    // Reference: decode ascii if possible, otherwise return the raw bytes.
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] >= 0x80) return raw;
    }
    let s = '';
    for (let i = 0; i < raw.length; i += 1) {
      s += String.fromCharCode(raw[i]);
    }
    return s;
  }

  protected readTwoByteString(): string {
    const length = this.readVarint();
    return UTF16LE_DECODER.decode(this.readRawBytes(length));
  }

  // -------------------------------------------------------------------------
  // Tag stream helpers
  // -------------------------------------------------------------------------

  /**
   * Read the next non-padding tag byte. Returns `EOF` (-1) at end-of-stream,
   * mirroring the reference's `_read_tag`, where `stream.read(1)` yields `b''`
   * at EOF (which is not equal to the padding byte, so it is returned as-is).
   * This EOF sentinel matters for the trailing ArrayBufferView peek in
   * `readObject`, which must be a no-op once the value is fully consumed.
   */
  protected readTag(): number {
    for (;;) {
      if (this.pos >= this.data.length) return EOF;
      const t = this.data[this.pos];
      this.pos += 1;
      if (t !== Tag.kPadding) return t;
    }
  }

  /** Peek the next non-padding tag byte without consuming it (EOF -> -1). */
  protected peekTag(): number {
    const start = this.pos;
    const tag = this.readTag();
    this.pos = start;
    return tag;
  }
}
