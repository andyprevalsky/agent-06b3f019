/**
 * V8 structured-clone value deserializer (native TypeScript port).
 *
 * A faithful, byte-for-byte 1:1 port of CCL Forensics'
 * `ccl_v8_value_deserializer.py` (`Deserializer`). Decodes the wire format
 * produced by V8's `ValueSerializer`
 * (https://github.com/v8/v8/blob/master/src/objects/value-serializer.cc), which
 * is what Chrome writes into IndexedDB object-store record values (after the
 * Blink envelope is stripped — see `blink-deserializer.ts` and the harness that
 * peels the IDB value-version + Blink-version varints).
 *
 * The low-level byte-reader primitives (cursor, varints, doubles, BigInt,
 * strings, tag stream, header) live in `V8ReaderBase` (`v8-reader-base.ts`);
 * this file holds the structured readers and tag dispatch.
 *
 * Design notes / fidelity contract:
 *   - Endianness, zigzag varints, LE varints (max 10 bytes / 5 for 32-bit),
 *     double byte order, and BigInt digit endianness all mirror the reference
 *     exactly.
 *   - The object reference table (`objects`) is preserved: exactly the same
 *     values are appended, in the same order, so `token_kObjectReference`
 *     resolves identically. Containers are pushed BEFORE they are filled so
 *     cyclic references resolve (as in the reference).
 *   - Values are represented as natural JS values where possible:
 *       * undefined / the-hole  -> the exported `UNDEFINED` sentinel (a real JS
 *         `undefined` would be dropped by `JSON.stringify` and could not be
 *         distinguished from a missing property; the sentinel is stable and is
 *         mapped by the downstream JSON serializer).
 *       * null -> `null`; true/false -> `boolean`
 *       * Int32 / Uint32 / Double / NumberObject -> `number`
 *       * BigInt / BigIntObject -> `bigint`
 *       * strings -> `string` (OneByteString returns a `Uint8Array` when the
 *         bytes are not pure ASCII, mirroring the reference).
 *       * Object / Map / Set / Array -> `Record<string, unknown>` / `Map` /
 *         `Set` / `Array` (the reference collapses Map+Object to `dict` and
 *         Set to `set`; we keep the richer JS types, a strict superset).
 *       * Date -> `Date`; RegExp -> `{ __type: 'RegExp', source }` (pattern
 *         only, as in the reference; flags are read and discarded).
 *       * ArrayBuffer -> `Uint8Array`
 *       * typed array / DataView view -> `number[]` (or `bigint[]` for 64-bit
 *         element types; `Uint8Array[]` of length-1 chunks for DataView).
 *       * SharedObject -> `{ __type: 'SharedObject', id }`
 *       * HostObject -> whatever the injected delegate returns.
 *
 * Not implemented (the reference raises for these too): SharedArrayBuffer,
 * ArrayBufferTransfer, Error, WasmModuleTransfer, WasmMemoryTransfer.
 */

import { makeBlinkHostObjectDelegate } from './blink-deserializer';
import {
  Tag,
  UNDEFINED,
  V8ReaderBase,
  V8Undefined,
  VIEW_ELEMENT_SPECS,
  type V8RegExp,
  type V8SharedObject,
} from './v8-reader-base';

// Re-export the public value shapes so the domain's public API is unchanged.
export { UNDEFINED, V8Undefined };
export type { V8RegExp, V8SharedObject };

/** Delegate invoked for `token_kHostObject`. Reads directly from the reader. */
export type HostObjectDelegate = (reader: Deserializer) => unknown;

/**
 * Faithful port of `ccl_v8_value_deserializer.Deserializer`.
 *
 * Construct with the raw V8 payload (starting at the `0xFF` version tag), a
 * host-object delegate, and optional endianness/pointer-size flags. The header
 * is read implicitly in the constructor (as the reference does); then call
 * `readValue()` to decode the single top-level value.
 */
export class Deserializer extends V8ReaderBase {
  private readonly hostObjectDelegate: HostObjectDelegate;
  private readonly objects: unknown[] = [];

  constructor(
    data: Uint8Array,
    deps: { hostObjectDelegate: HostObjectDelegate },
    opts?: { isLittleEndian?: boolean; is64bit?: boolean }
  ) {
    super(data, opts);
    this.hostObjectDelegate = deps.hostObjectDelegate;
  }

  private readString(): string {
    if (this.version < 12) {
      return this.readUtf8String();
    }
    const value = this.readObject();
    if (typeof value !== 'string') {
      throw new Error('Expected a string');
    }
    return value;
  }

  private readObjectByReference(): unknown {
    const refId = this.readVarint();
    return this.objects[refId];
  }

  private readDate(): Date {
    const x = this.readDouble();
    const result = new Date(x);
    this.objects.push(result);
    return result;
  }

  private readJsRegex(): V8RegExp {
    const pattern = this.readString();
    // flags: read and discard (mirrors reference `re.compile(pattern)` only).
    this.readVarintBig();
    const regex: V8RegExp = { __type: 'RegExp', source: pattern };
    this.objects.push(regex);
    return regex;
  }

  /**
   * Read key/value property pairs until `endTag` is peeked, then consume it.
   * Mirrors `_read_js_object_properties`.
   */
  private *readJsObjectProperties(endTag: number): Generator<[unknown, unknown]> {
    for (;;) {
      if (this.peekTag() === endTag) break;
      const key = this.readObject();
      const value = this.readObject();
      yield [key, value];
    }
    assertEq(this.readTag(), endTag, 'Object end tag mismatch');
  }

  private readJsObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.objects.push(result);
    let count = 0;
    for (const [key, value] of this.readJsObjectProperties(Tag.kEndJSObject)) {
      result[propertyKeyToString(key)] = value;
      count += 1;
    }
    assertEq(count, this.readVarint(), 'Property count mismatch');
    return result;
  }

  private readJsSparseArray(): unknown[] {
    const length = this.readVarint();
    const result: unknown[] = new Array<unknown>(length).fill(null);
    this.objects.push(result);

    let propCount = 0;
    for (const [key, value] of this.readJsObjectProperties(Tag.kEndSparseJSArray)) {
      result[keyToArrayIndex(key)] = value;
      propCount += 1;
    }
    assertEq(propCount, this.readVarint(), 'Property count mismatch');
    // expected_length (unchecked in the reference)
    this.readVarintBig();
    return result;
  }

  private readJsDenseArray(): unknown[] {
    const length = this.readVarint();
    const result: unknown[] = new Array<unknown>(length).fill(null);
    this.objects.push(result);

    for (let i = 0; i < length; i += 1) {
      result[i] = this.readObject();
    }

    let propCount = 0;
    for (const [key, value] of this.readJsObjectProperties(Tag.kEndDenseJSArray)) {
      result[keyToArrayIndex(key)] = value;
      propCount += 1;
    }
    assertEq(propCount, this.readVarint(), 'Property count mismatch');
    // expected_length (unchecked in the reference)
    this.readVarintBig();
    return result;
  }

  private readJsMap(): Map<unknown, unknown> {
    const result = new Map<unknown, unknown>();
    this.objects.push(result);
    for (;;) {
      if (this.peekTag() === Tag.kEndJSMap) break;
      const key = this.readObject();
      const value = this.readObject();
      result.set(key, value);
    }
    assertEq(this.readTag(), Tag.kEndJSMap, 'Map end tag mismatch');
    assertEq(this.readVarint(), result.size * 2, 'Map count mismatch');
    return result;
  }

  private readJsSet(): Set<unknown> {
    const result = new Set<unknown>();
    this.objects.push(result);
    for (;;) {
      if (this.peekTag() === Tag.kEndJSSet) break;
      result.add(this.readObject());
    }
    assertEq(this.readTag(), Tag.kEndJSSet, 'Set end tag mismatch');
    assertEq(this.readVarint(), result.size, 'Set count mismatch');
    return result;
  }

  private readJsArrayBuffer(): Uint8Array {
    const length = this.readVarint();
    const raw = this.readRawBytes(length);
    this.objects.push(raw);
    return raw;
  }

  /**
   * Wrap the preceding ArrayBuffer bytes into a typed-array view. Mirrors
   * `_wrap_js_array_buffer_view`: returns an array of decoded elements.
   */
  private wrapJsArrayBufferView(raw: unknown): (number | bigint | Uint8Array)[] {
    if (!(raw instanceof Uint8Array)) {
      throw new TypeError('Only bytes should be passed to be wrapped in a buffer view');
    }
    const tag = this.readVarint(); // subtag char code
    const byteOffset = this.readVarint();
    const byteLength = this.readVarint();

    if (byteOffset + byteLength > raw.length) {
      throw new Error('Not enough data in the raw data to hold the defined data');
    }

    // See value-serializer.cc: flags added in wire-format version 14.
    if (this.version >= 14) {
      this.readVarintBig();
    }

    const spec = VIEW_ELEMENT_SPECS[tag];
    if (spec === undefined) {
      throw new Error(`Unknown ArrayBufferView tag ${String(tag)}`);
    }
    if (byteLength % spec.size !== 0) {
      throw new Error(
        `ArrayBufferView doesn't fit nicely: byte_length: ${String(byteLength)}; ` +
          `element_length: ${String(spec.size)}`
      );
    }

    const elementCount = byteLength / spec.size;
    const view = new DataView(raw.buffer, raw.byteOffset + byteOffset, byteLength);
    const out: (number | bigint | Uint8Array)[] = [];
    for (let i = 0; i < elementCount; i += 1) {
      out.push(spec.read(view, i * spec.size, this.littleEndian));
    }
    return out;
  }

  private readHostObject(): unknown {
    const result = this.hostObjectDelegate(this);
    this.objects.push(result);
    return result;
  }

  private readSharedObject(): V8SharedObject {
    const id = this.readVarint();
    return { __type: 'SharedObject', id };
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private readObjectInternal(): { tag: number; value: unknown } {
    const tag = this.readTag();

    switch (tag) {
      case Tag.kUndefined:
      case Tag.kTheHole:
        return { tag, value: UNDEFINED };
      case Tag.kNull:
        return { tag, value: null };
      case Tag.kTrue:
        return { tag, value: true };
      case Tag.kFalse:
        return { tag, value: false };
      default:
        break;
    }

    const scalar = this.readScalarForTag(tag);
    const value = scalar !== null ? scalar.value : this.readCompositeForTag(tag);

    // Wrapped primitives are pushed onto the reference table (as in reference).
    if (
      tag === Tag.kTrueObject ||
      tag === Tag.kFalseObject ||
      tag === Tag.kNumberObject ||
      tag === Tag.kBigIntObject ||
      tag === Tag.kStringObject
    ) {
      this.objects.push(value);
    }

    return { tag, value };
  }

  /**
   * Decode a scalar/primitive tag. Returns `null` (not a scalar tag) so the
   * caller falls through to the composite dispatch. Wrapped in `{ value }` so a
   * legitimately falsy result (`false`, `0`, `''`) is not confused with "no
   * match".
   */
  private readScalarForTag(tag: number): { value: unknown } | null {
    switch (tag) {
      case Tag.kTrueObject:
        return { value: true };
      case Tag.kFalseObject:
        return { value: false };
      case Tag.kNumberObject:
      case Tag.kDouble:
        return { value: this.readDouble() };
      case Tag.kUint32:
        return { value: this.readUint32() };
      case Tag.kInt32:
        return { value: this.readZigzag() };
      case Tag.kDate:
        return { value: this.readDate() };
      case Tag.kBigInt:
      case Tag.kBigIntObject:
        return { value: this.readBigInt() };
      case Tag.kUtf8String:
        return { value: this.readUtf8String() };
      case Tag.kOneByteString:
        return { value: this.readOneByteString() };
      case Tag.kTwoByteString:
        return { value: this.readTwoByteString() };
      case Tag.kStringObject:
        return { value: this.readString() };
      case Tag.kRegExp:
        return { value: this.readJsRegex() };
      case Tag.kObjectReference:
        return { value: this.readObjectByReference() };
      default:
        return null;
    }
  }

  /** Decode a composite/container tag, or throw on unknown/unimplemented tags. */
  private readCompositeForTag(tag: number): unknown {
    switch (tag) {
      case Tag.kBeginJSObject:
        return this.readJsObject();
      case Tag.kSharedObject:
        return this.readSharedObject();
      case Tag.kBeginSparseJSArray:
        return this.readJsSparseArray();
      case Tag.kBeginDenseJSArray:
        return this.readJsDenseArray();
      case Tag.kBeginJSMap:
        return this.readJsMap();
      case Tag.kBeginJSSet:
        return this.readJsSet();
      case Tag.kArrayBuffer:
        return this.readJsArrayBuffer();
      case Tag.kHostObject:
        return this.readHostObject();
      case Tag.kSharedArrayBuffer:
      case Tag.kArrayBufferTransfer:
      case Tag.kError:
      case Tag.kWasmModuleTransfer:
      case Tag.kWasmMemoryTransfer:
        throw new Error('Not implemented');
      default:
        throw new Error(`Unknown tag ${String(tag)}`);
    }
  }

  /** Read one value, applying the ArrayBuffer -> view wrapping quirk. */
  private readObject(): unknown {
    const { value } = this.readObjectInternal();
    if (this.peekTag() === Tag.kArrayBufferView) {
      assertEq(this.readTag(), Tag.kArrayBufferView, 'ArrayBufferView tag mismatch');
      return this.wrapJsArrayBufferView(value);
    }
    return value;
  }

  /** Read the single top-level value (mirrors `Deserializer.read`). */
  public readValue(): unknown {
    return this.readObject();
  }
}

/** Throw `message` unless two decoded counts/tags are equal (mirrors the reference asserts). */
function assertEq(actual: number, expected: number, message: string): void {
  if (actual !== expected) {
    throw new Error(message);
  }
}

/**
 * Coerce a decoded property key to a string. V8 object property keys are
 * strings or int32 array indices; the reference stores them as Python dict
 * keys verbatim, and `JSON` coerces non-string keys to strings. We do the same
 * so an int32 index key and its string form collapse identically.
 */
function propertyKeyToString(key: unknown): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'number') return String(key);
  if (typeof key === 'bigint') return key.toString();
  return String(key);
}

/** Coerce a decoded key to an array index (mirrors `int(key)`). */
function keyToArrayIndex(key: unknown): number {
  if (typeof key === 'number') return key;
  if (typeof key === 'bigint') return Number(key);
  if (typeof key === 'string') return Number.parseInt(key, 10);
  throw new Error(`Cannot use ${String(key)} as an array index`);
}

/**
 * Decode a bare V8 structured-clone payload (starting at the `0xFF` version
 * header) into a JS value, wiring in the Blink host-object delegate for DOM
 * types. This is the one entrypoint the IndexedDB layer calls.
 *
 * Mirrors `ccl_chromium_indexeddb.iterate_records`, which does
 * `Deserializer(obj_raw, host_object_delegate=blink_deserializer.read).read()`.
 *
 * The caller is expected to hand us a payload that is already past the IDB
 * value-version varint AND past the Blink envelope/trailer — i.e. it begins at
 * the V8 `0xFF <version>` header. The header is consumed by the `Deserializer`
 * constructor (faithful to ccl, which reads the header in `__init__`), so we do
 * not strip any Blink envelope here; we simply read the header + top-level
 * value, invoking the Blink delegate whenever the V8 stream hits a HostObject
 * tag. Blink envelope-stripping lives separately (see the validation harness /
 * `blink-deserializer.ts`) for callers that start one layer up.
 */
export function deserializeV8Value(v8Payload: Uint8Array): unknown {
  const deserializer = new Deserializer(v8Payload, {
    hostObjectDelegate: makeBlinkHostObjectDelegate(),
  });
  // `readHeader()` already ran inside the constructor; read the value now.
  return deserializer.readValue();
}
