/**
 * Blackbox tests for `main/base/crypto.ts` — the AES-256-CBC encryption helper
 * used by the batch uploader / browser-state-sync payload paths.
 *
 * The existing `batch-uploader.blackbox.ts` suite exercises `Crypto.encrypt`
 * live, but only ever feeds it *object* input, so the documented dual contract
 * ("accepts either a Buffer for pre-compressed data OR any JSON-serializable
 * object") is only half covered — the `Buffer.isBuffer(data)` true-branch never
 * runs. This suite locks down both branches by round-tripping each input kind
 * through a real `createDecipheriv`, and asserts the per-call key/iv freshness
 * that makes the ciphertext safe to store.
 *
 * We use the real node `crypto` (works in jsdom) with no mocks — this is a pure
 * deterministic-in/out contract.
 */

import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { Crypto } from '../../main/base/crypto';

/** Decrypt a payload produced by Crypto.encrypt back into raw bytes. */
function decrypt(encrypted: string, iv: string, key: string): Buffer {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'hex')
  );
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]);
}

describe('main/base/crypto — Crypto.encrypt', () => {
  it('encrypts a JSON-serializable object (non-Buffer branch) and round-trips it', () => {
    const data = { userId: 'abc-123', cookies: [{ name: 'sid', value: 'xyz' }], count: 2 };

    const { encrypted, iv, key } = Crypto.encrypt(data);

    // Hex-encoded outputs of the expected key/iv widths.
    expect(key).toMatch(/^[0-9a-f]{64}$/); // 32 bytes
    expect(iv).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(encrypted).toMatch(/^[0-9a-f]+$/);

    // Object input is JSON.stringify'd before encryption.
    const plaintext = decrypt(encrypted, iv, key).toString('utf8');
    expect(JSON.parse(plaintext)).toEqual(data);
    expect(plaintext).toBe(JSON.stringify(data));
  });

  it('encrypts a raw Buffer directly (Buffer branch) without JSON-stringifying it', () => {
    // Non-UTF8, non-JSON bytes: proves the Buffer path does NOT run JSON.stringify
    // (which would have mangled these bytes / wrapped them in quotes).
    const raw = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80]);

    const { encrypted, iv, key } = Crypto.encrypt(raw);

    const decrypted = decrypt(encrypted, iv, key);
    expect(decrypted.equals(raw)).toBe(true);
  });

  it('produces a fresh random key + iv on every call (no reuse)', () => {
    const a = Crypto.encrypt({ v: 1 });
    const b = Crypto.encrypt({ v: 1 });

    // Same plaintext, but independent key/iv → ciphertext differs.
    expect(a.key).not.toBe(b.key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it('handles an empty Buffer (Buffer branch, zero-length input)', () => {
    const raw = Buffer.alloc(0);
    const { encrypted, iv, key } = Crypto.encrypt(raw);
    expect(decrypt(encrypted, iv, key).length).toBe(0);
  });
});
