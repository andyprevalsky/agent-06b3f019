/**
 * Blink structured-clone host-object deserializer (native TypeScript port).
 *
 * A faithful 1:1 port of CCL Forensics' `ccl_blink_value_deserializer.py`
 * (`BlinkV8Deserializer`). Blink layers its own DOM-type tags on top of V8's
 * `ValueSerializer`: whenever the V8 stream emits a `token_kHostObject` tag, V8
 * hands control to a delegate — for Blink-serialized data that delegate reads
 * one Blink tag byte and decodes a DOM type (Blob, File, FileList, ImageData,
 * CryptoKey, DOMPoint, …).
 *
 * References:
 *   third_party/blink/renderer/bindings/core/v8/serialization
 *   third_party/blink/renderer/bindings/modules/v8/serialization/
 *     v8_script_value_serializer_for_modules.cc
 *
 * Fidelity contract:
 *   - Only the tags the reference actually decodes are implemented; every other
 *     tag throws (the reference raises `NotImplementedError` / `ValueError`).
 *   - Types that reference external blob files (`BlobIndex`, file lists) return
 *     a small descriptor object mirroring ccl's dataclasses — we never read
 *     external files, exactly like the note in the task contract.
 *   - CryptoKey mirrors ccl's `CryptoKey` dataclass field-for-field; enum
 *     fields are represented as their integer values, byte fields as
 *     `Uint8Array`.
 *
 * The Blink delegate reads from the SAME byte stream as the V8 `Deserializer`,
 * so it consumes bytes via the reader's low-level primitives (`readByte`,
 * `readRawBytes`, `readVarint`, `readVarint(true)` for 32-bit,
 * `readUtf8StringVarint32`). This matches the reference, where the delegate is
 * handed the underlying stream object.
 */

import type { Deserializer } from './v8-deserializer';

/** Blob vs File discriminator for a `BlobIndex` (mirrors `BlobIndexType`). */
export enum BlobIndexType {
  Blob = 0,
  File = 1,
}

/** Descriptor for an externally-stored Blob/File (mirrors ccl `BlobIndex`). */
export interface BlobIndex {
  readonly __type: 'BlobIndex';
  readonly indexType: BlobIndexType;
  readonly indexId: number;
}

/** Descriptor for a File System Access handle (mirrors ccl `NativeFileHandle`). */
export interface NativeFileHandle {
  readonly __type: 'NativeFileHandle';
  readonly isDir: boolean;
  readonly name: string;
  readonly tokenIndex: number;
}

/**
 * Decoded WebCrypto key (mirrors ccl `CryptoKey` dataclass). Enum fields are
 * their integer values; `publicExponent` / `keyData` are raw bytes.
 */
export interface CryptoKey {
  readonly __type: 'CryptoKey';
  readonly subType: number;
  readonly algorithmType: number | null;
  readonly hashType: number | null;
  readonly asymmetricKeyType: number | null;
  readonly byteLength: number | null;
  readonly publicExponent: Uint8Array | null;
  readonly namedCurveType: number | null;
  readonly keyUsage: number;
  readonly keyData: Uint8Array;
}

/**
 * WebCrypto key subtypes. See
 * third_party/blink/renderer/bindings/modules/v8/serialization/web_crypto_sub_tags.h
 */
enum V8CryptoKeySubType {
  AesKey = 1,
  HmacKey = 2,
  // ID 3 was used by RsaKeyTag while behind experimental flag.
  RsaHashedKey = 4,
  EcKey = 5,
  NoParamsKey = 6,
}

enum V8AsymmetricCryptoKeyType {
  Public = 1,
  Private = 2,
}

/** Blink DOM-type tag byte codes (see reference `Constants`). */
const BlinkTag = {
  kMessagePort: 0x4d, // 'M'
  kMojoHandle: 0x68, // 'h'
  kBlob: 0x62, // 'b'
  kBlobIndex: 0x69, // 'i'
  kFile: 0x66, // 'f'
  kFileIndex: 0x65, // 'e'
  kDOMFileSystem: 0x64, // 'd'
  kNativeFileSystemFileHandle: 0x6e, // 'n'
  kNativeFileSystemDirectoryHandle: 0x4e, // 'N'
  kFileList: 0x6c, // 'l'
  kFileListIndex: 0x4c, // 'L'
  kImageData: 0x23, // '#'
  kImageBitmap: 0x67, // 'g'
  kImageBitmapTransfer: 0x47, // 'G'
  kOffscreenCanvasTransfer: 0x48, // 'H'
  kReadableStreamTransfer: 0x72, // 'r'
  kTransformStreamTransfer: 0x6d, // 'm'
  kWritableStreamTransfer: 0x77, // 'w'
  kDOMPoint: 0x51, // 'Q'
  kDOMPointReadOnly: 0x57, // 'W'
  kDOMRect: 0x45, // 'E'
  kDOMRectReadOnly: 0x52, // 'R'
  kDOMQuad: 0x54, // 'T'
  kDOMMatrix: 0x59, // 'Y'
  kDOMMatrixReadOnly: 0x55, // 'U'
  kDOMMatrix2D: 0x49, // 'I'
  kDOMMatrix2DReadOnly: 0x4f, // 'O'
  kCryptoKey: 0x4b, // 'K'
  kRTCCertificate: 0x6b, // 'k'
  kRTCEncodedAudioFrame: 0x41, // 'A'
  kRTCEncodedVideoFrame: 0x56, // 'V'
  kVideoFrame: 0x76, // 'v'
  kDOMException: 0x78, // 'x'
} as const;

/**
 * Faithful port of `ccl_blink_value_deserializer.BlinkV8Deserializer`.
 *
 * `read(reader)` reads one Blink tag byte from the shared stream and decodes
 * the corresponding DOM type. Only the tags decoded by the reference are
 * supported; all others throw.
 */
export class BlinkV8Deserializer {
  /** `_read_varint` — full LE varint. */
  private readVarint(reader: Deserializer): number {
    return reader.readVarint();
  }

  /** `_read_varint32` — 32-bit-capped LE varint. */
  private readVarint32(reader: Deserializer): number {
    return reader.readVarint(true);
  }

  /** `_read_utf8_string` — uint32-varint-length-prefixed UTF-8. */
  private readUtf8String(reader: Deserializer): string {
    return reader.readUtf8StringVarint32();
  }

  private readFileIndex(reader: Deserializer): BlobIndex {
    return { __type: 'BlobIndex', indexType: BlobIndexType.File, indexId: this.readVarint(reader) };
  }

  private readBlobIndex(reader: Deserializer): BlobIndex {
    return { __type: 'BlobIndex', indexType: BlobIndexType.Blob, indexId: this.readVarint(reader) };
  }

  private readFileListIndex(reader: Deserializer): BlobIndex[] {
    const length = this.readVarint(reader);
    const result: BlobIndex[] = [];
    for (let i = 0; i < length; i += 1) {
      result.push(this.readFileIndex(reader));
    }
    return result;
  }

  private readNativeFileHandle(isDir: boolean, reader: Deserializer): NativeFileHandle {
    const name = this.readUtf8String(reader);
    const tokenIndex = this.readVarint(reader);
    return { __type: 'NativeFileHandle', isDir, name, tokenIndex };
  }

  private readCryptoKey(reader: Deserializer): CryptoKey {
    const subType = reader.readByte();

    let algorithmType: number | null = null;
    let hashType: number | null = null;
    let asymmetricKeyType: number | null = null;
    let byteLength: number | null = null;
    let publicExponent: Uint8Array | null = null;
    let namedCurveType: number | null = null;

    switch (subType) {
      case V8CryptoKeySubType.AesKey: {
        algorithmType = this.readVarint32(reader);
        byteLength = this.readVarint32(reader);
        break;
      }
      case V8CryptoKeySubType.HmacKey: {
        byteLength = this.readVarint32(reader);
        hashType = this.readVarint32(reader);
        break;
      }
      case V8CryptoKeySubType.RsaHashedKey: {
        algorithmType = this.readVarint32(reader);
        asymmetricKeyType = reader.readByte();
        byteLength = this.readVarint32(reader);
        const publicExponentLength = this.readVarint32(reader);
        publicExponent = reader.readRawBytes(publicExponentLength);
        hashType = this.readVarint32(reader);
        break;
      }
      case V8CryptoKeySubType.EcKey: {
        algorithmType = this.readVarint32(reader);
        asymmetricKeyType = reader.readByte();
        namedCurveType = this.readVarint32(reader);
        break;
      }
      case V8CryptoKeySubType.NoParamsKey: {
        algorithmType = this.readVarint32(reader);
        break;
      }
      default:
        throw new Error(`Unknown V8CryptoKeySubType ${String(subType)}`);
    }

    // Validate the enum discriminators the reference constructs (they raise on
    // out-of-range values via `V8AsymmetricCryptoKeyType(...)`).
    if (
      asymmetricKeyType !== null &&
      asymmetricKeyType !== V8AsymmetricCryptoKeyType.Public &&
      asymmetricKeyType !== V8AsymmetricCryptoKeyType.Private
    ) {
      throw new Error(`Unknown V8AsymmetricCryptoKeyType ${String(asymmetricKeyType)}`);
    }

    const keyUsage = this.readVarint32(reader);
    const keyLength = this.readVarint32(reader);
    const keyData = reader.readRawBytes(keyLength);

    return {
      __type: 'CryptoKey',
      subType,
      algorithmType,
      hashType,
      asymmetricKeyType,
      byteLength,
      publicExponent,
      namedCurveType,
      keyUsage,
      keyData,
    };
  }

  /**
   * Read one Blink host object from the stream. Mirrors
   * `BlinkV8Deserializer.read`: read a single tag byte and dispatch.
   */
  public read(reader: Deserializer, tag?: number): unknown {
    const t = tag ?? reader.readByte();

    switch (t) {
      case BlinkTag.kBlobIndex:
        return this.readBlobIndex(reader);
      case BlinkTag.kFileIndex:
        return this.readFileIndex(reader);
      case BlinkTag.kNativeFileSystemFileHandle:
        return this.readNativeFileHandle(false, reader);
      case BlinkTag.kNativeFileSystemDirectoryHandle:
        return this.readNativeFileHandle(true, reader);
      case BlinkTag.kFileListIndex:
        return this.readFileListIndex(reader);
      case BlinkTag.kCryptoKey:
        return this.readCryptoKey(reader);
      // Tags the reference explicitly maps to `_not_implemented`.
      case BlinkTag.kMessagePort:
      case BlinkTag.kMojoHandle:
      case BlinkTag.kBlob:
      case BlinkTag.kFile:
      case BlinkTag.kDOMFileSystem:
      case BlinkTag.kFileList:
      case BlinkTag.kImageData:
      case BlinkTag.kImageBitmap:
      case BlinkTag.kImageBitmapTransfer:
      case BlinkTag.kOffscreenCanvasTransfer:
      case BlinkTag.kReadableStreamTransfer:
      case BlinkTag.kTransformStreamTransfer:
      case BlinkTag.kWritableStreamTransfer:
      case BlinkTag.kDOMPoint:
      case BlinkTag.kDOMPointReadOnly:
      case BlinkTag.kDOMRect:
      case BlinkTag.kDOMRectReadOnly:
      case BlinkTag.kDOMQuad:
      case BlinkTag.kDOMMatrix:
      case BlinkTag.kDOMMatrixReadOnly:
      case BlinkTag.kDOMMatrix2D:
      case BlinkTag.kDOMMatrix2DReadOnly:
      case BlinkTag.kRTCCertificate:
      case BlinkTag.kRTCEncodedAudioFrame:
      case BlinkTag.kRTCEncodedVideoFrame:
      case BlinkTag.kVideoFrame:
      case BlinkTag.kDOMException:
        throw new Error(`Not implemented Blink tag ${String(t)}`);
      default:
        throw new Error(`Unknown tag: ${String(t)}`);
    }
  }
}

/**
 * Build the host-object delegate for the V8 `Deserializer`. Mirrors passing
 * `blink_deserializer.read` as `host_object_delegate` in ccl. The returned
 * closure reads one Blink tag byte from the shared stream and decodes the DOM
 * type.
 */
export function makeBlinkHostObjectDelegate(): (reader: Deserializer) => unknown {
  const blink = new BlinkV8Deserializer();
  return (reader: Deserializer): unknown => blink.read(reader);
}
