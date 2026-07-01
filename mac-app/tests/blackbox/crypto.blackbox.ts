/**
 * Blackbox tests for main/base/crypto.ts.
 *
 * The shared Crypto helper has two observable input modes:
 *   - JSON-serializable values are stringified before encryption.
 *   - Buffer values are encrypted as raw bytes.
 *
 * These tests decrypt the produced envelope with the returned key/iv and assert
 * the caller-visible contract without mocking random key generation.
 */

import nodeCrypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { Crypto, type EncryptedData } from '../../main/base/crypto';

function decryptPayload(payload: EncryptedData): Buffer {
  const decipher = nodeCrypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(payload.key, 'hex'),
    Buffer.from(payload.iv, 'hex')
  );
  return Buffer.concat([decipher.update(Buffer.from(payload.encrypted, 'hex')), decipher.final()]);
}

describe('crypto blackbox', () => {
  it('encrypts JSON-serializable data by stringifying it first', () => {
    const payload = Crypto.encrypt({ ok: true, count: 2 });

    expect(payload.key).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.iv).toMatch(/^[0-9a-f]{32}$/);
    expect(decryptPayload(payload).toString('utf8')).toBe('{"ok":true,"count":2}');
  });

  it('encrypts Buffer data as raw bytes', () => {
    const input = Buffer.from([0, 1, 2, 250, 255]);

    const payload = Crypto.encrypt(input);

    expect(decryptPayload(payload)).toEqual(input);
  });
});
