/**
 * Pure-TypeScript port of Google's Snappy block decompression.
 *
 * Faithful 1:1 reimplementation of `ccl_simplesnappy.decompress` (CCL Forensics),
 * operating on a single raw (non-framed) Snappy block: a leading unsigned
 * base-128 varint giving the uncompressed length, followed by a stream of
 * literal / copy tags.
 *
 * Only the raw-block path is ported here — the framed-stream handling
 * (`decompress_framed`, CRC checks) in the reference is not needed for LevelDB
 * table blocks, which store bare Snappy blocks.
 *
 * See: https://github.com/google/snappy/blob/main/format_description.txt
 */

/** Run type in the compressed Snappy data (matches ccl `ElementType`). */
const enum ElementType {
  Literal = 0,
  CopyOneByte = 1,
  CopyTwoByte = 2,
  CopyFourByte = 3,
}

/**
 * Minimal forward byte cursor over a `Uint8Array`, mirroring the stream reads
 * the Python reference performs against an `io.BytesIO`.
 */
class ByteReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Bytes consumed so far (equivalent to `stream.tell()`). */
  tell(): number {
    return this.pos;
  }

  /** Read one byte, or `null` at end-of-data (mirrors `read_byte`). */
  readByte(): number | null {
    if (this.pos >= this.data.length) return null;
    return this.data[this.pos++];
  }

  /** Read `count` bytes; returns however many remain if short. */
  read(count: number): Uint8Array {
    const end = Math.min(this.pos + count, this.data.length);
    const out = this.data.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  /** Little-endian uint16. */
  readUint16(): number {
    const b = this.read(2);
    return b[0] | (b[1] << 8);
  }

  /** Little-endian uint24. */
  readUint24(): number {
    const b = this.read(3);
    return b[0] | (b[1] << 8) | (b[2] << 16);
  }

  /** Little-endian uint32 (unsigned). */
  readUint32(): number {
    const b = this.read(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  /**
   * Read an unsigned LE base-128 varint, or `null` at end-of-data. Mirrors
   * `read_le_varint`: up to 10 groups of 7 bits, low group first.
   */
  readVarint(): number | null {
    let result = 0;
    let i = 0;
    while (i < 10) {
      const raw = this.readByte();
      if (raw === null) return null;
      // Use multiplication (not <<) so values above 31 bits stay exact.
      result += (raw & 0x7f) * Math.pow(2, i * 7);
      if ((raw & 0x80) === 0) break;
      i += 1;
    }
    return result;
  }
}

/**
 * Growable output buffer for the decompressed stream. Supports back-reference
 * copies that read bytes written earlier in the same buffer (including the
 * self-overlapping case where the copy length exceeds the back-offset).
 */
class OutputBuffer {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity: number) {
    this.buf = new Uint8Array(Math.max(initialCapacity, 16));
  }

  /** Current length (equivalent to `out.tell()`). */
  tell(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Append raw literal bytes. */
  writeBytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  /**
   * Copy `length` bytes from `absoluteOffset` (a position already written)
   * forward. Byte-by-byte so a self-overlapping copy tiles correctly — this
   * produces the identical result to the reference's `(buffer * length)[:length]`
   * tiling branch.
   */
  copyFrom(absoluteOffset: number, length: number): void {
    this.ensure(length);
    for (let i = 0; i < length; i++) {
      this.buf[this.len + i] = this.buf[absoluteOffset + i];
    }
    this.len += length;
  }

  /** Final decompressed bytes (a copy trimmed to length). */
  value(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Decompress a single raw Snappy block.
 *
 * @param data Raw (non-framed) Snappy block bytes.
 * @returns The decompressed bytes.
 * @throws If the block is malformed or the decoded length disagrees with the
 *   varint-declared uncompressed length.
 */
export function snappyDecompressBlock(data: Uint8Array): Uint8Array {
  const reader = new ByteReader(data);

  const uncompressedLength = reader.readVarint();
  if (uncompressedLength === null) {
    throw new Error('Snappy: could not read uncompressed length');
  }

  const out = new OutputBuffer(uncompressedLength);

  for (;;) {
    const typeByte = reader.readByte();
    if (typeByte === null) break;

    const tag = typeByte & 0x03;

    if (tag === ElementType.Literal) {
      const lenTag = (typeByte & 0xfc) >> 2;
      let length: number;
      if (lenTag < 60) {
        length = 1 + lenTag;
      } else if (lenTag === 60) {
        const b = reader.readByte();
        if (b === null) throw new Error('Snappy: truncated 8-bit literal length');
        length = 1 + b;
      } else if (lenTag === 61) {
        length = 1 + reader.readUint16();
      } else if (lenTag === 62) {
        length = 1 + reader.readUint24();
      } else {
        // lenTag === 63
        length = 1 + reader.readUint32();
      }

      const literalData = reader.read(length);
      if (literalData.length < length) {
        throw new Error("Snappy: couldn't read enough literal data");
      }
      out.writeBytes(literalData);
    } else {
      let length: number;
      let offset: number;
      if (tag === ElementType.CopyOneByte) {
        length = ((typeByte & 0x1c) >> 2) + 4;
        const b = reader.readByte();
        if (b === null) throw new Error('Snappy: truncated one-byte copy');
        offset = ((typeByte & 0xe0) << 3) | b;
      } else if (tag === ElementType.CopyTwoByte) {
        length = 1 + ((typeByte & 0xfc) >> 2);
        offset = reader.readUint16();
      } else {
        // tag === ElementType.CopyFourByte
        length = 1 + ((typeByte & 0xfc) >> 2);
        offset = reader.readUint32();
      }

      if (offset === 0) {
        throw new Error('Snappy: offset cannot be 0');
      }

      const actualOffset = out.tell() - offset;
      out.copyFrom(actualOffset, length);
    }
  }

  const result = out.value();
  if (uncompressedLength !== result.length) {
    throw new Error('Snappy: wrong data length in uncompressed data');
  }

  return result;
}
