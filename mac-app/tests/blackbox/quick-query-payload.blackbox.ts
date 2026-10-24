/**
 * The quick-query payload crosses the IPC boundary from the renderer, so every
 * field is untrusted. `normalizeQuickQueryPayload` is the only thing standing
 * between a malformed/hostile payload and the agent-creation path, and it is
 * expected to coerce rather than throw — a thrown error here silently drops the
 * user's query. These cases pin each rejection branch so a future refactor
 * cannot let a partially-formed attachment through.
 */

import { describe, it, expect } from 'vitest';
import { normalizeQuickQueryPayload } from '../../main/app/quickQueryPayload';

describe('normalizeQuickQueryPayload', () => {
  it('accepts a bare string as the query', () => {
    const result = normalizeQuickQueryPayload('find me a flight');
    expect(result.query).toBe('find me a flight');
    expect(typeof result.submittedAt).toBe('number');
    expect(result.attachments).toBeUndefined();
  });

  it('falls back to an empty query for null, undefined, and non-objects', () => {
    for (const input of [null, undefined, 42, true, Symbol('x')]) {
      const result = normalizeQuickQueryPayload(input);
      expect(result.query).toBe('');
      expect(typeof result.submittedAt).toBe('number');
    }
  });

  it('coerces a non-string query and a non-numeric submittedAt', () => {
    const result = normalizeQuickQueryPayload({ query: { evil: true }, submittedAt: 'nope' });
    expect(result.query).toBe('');
    expect(typeof result.submittedAt).toBe('number');
  });

  it('preserves a caller-supplied numeric submittedAt', () => {
    const result = normalizeQuickQueryPayload({ query: 'hi', submittedAt: 1234 });
    expect(result.submittedAt).toBe(1234);
  });

  it('replaces a non-finite submittedAt, which would otherwise never expire', () => {
    // The consumer expires a submit by its age; `Date.now() - NaN` is never
    // greater than the limit, so a NaN timestamp would launch at any age.
    const before = Date.now();
    for (const submittedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = normalizeQuickQueryPayload({ query: 'hi', submittedAt });
      expect(Number.isFinite(result.submittedAt)).toBe(true);
      expect(result.submittedAt).toBeGreaterThanOrEqual(before);
    }
  });

  it('omits the attachments key entirely when none survive normalization', () => {
    // Not `attachments: []` — a present-but-empty array reads downstream as
    // "the user attached something that failed to load".
    expect(normalizeQuickQueryPayload({ query: 'q', attachments: [] }).attachments).toBeUndefined();
    expect(
      normalizeQuickQueryPayload({ query: 'q', attachments: 'not-an-array' }).attachments
    ).toBeUndefined();
  });

  it('drops attachments that are unusable rather than passing a broken one through', () => {
    const result = normalizeQuickQueryPayload({
      query: 'q',
      attachments: [
        null, // not an object
        'string-item', // not an object
        { name: '', data: new Uint8Array([1]).buffer }, // no name
        { name: 'no-data.png' }, // no data
        { name: 'empty.png', data: new ArrayBuffer(0) }, // zero-length
        { name: 'unsupported.png', data: { not: 'a buffer' } }, // undecodable
      ],
    });
    expect(result.attachments).toBeUndefined();
  });

  it('accepts an ArrayBuffer attachment and defaults its mime type', () => {
    const result = normalizeQuickQueryPayload({
      query: 'q',
      attachments: [{ name: 'a.bin', data: new Uint8Array([1, 2, 3]).buffer }],
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0].mimeType).toBe('application/octet-stream');
    expect(result.attachments?.[0].name).toBe('a.bin');
  });

  it('derives size from the buffer when size is missing or non-positive', () => {
    const build = (size: unknown) =>
      normalizeQuickQueryPayload({
        query: 'q',
        attachments: [{ name: 'a.bin', size, data: new Uint8Array([1, 2, 3, 4]).buffer }],
      }).attachments?.[0];

    expect(build(undefined)?.size).toBe(4);
    expect(build(0)?.size).toBe(4);
    expect(build(-5)?.size).toBe(4);
    expect(build(99)?.size).toBe(99);
  });

  it('copies only the viewed region of a typed-array view', () => {
    // A Uint8Array view over a larger buffer must contribute its own window,
    // not the whole backing buffer — otherwise unrelated adjacent bytes leak
    // into the upload.
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;
    const view = new Uint8Array(backing, 2, 3);
    const result = normalizeQuickQueryPayload({
      query: 'q',
      attachments: [{ name: 'window.bin', mimeType: 'image/png', data: view }],
    });

    const attachment = result.attachments?.[0];
    expect(attachment?.mimeType).toBe('image/png');
    expect(attachment?.data.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(attachment!.data))).toEqual([1, 2, 3]);
  });

  it('keeps the usable attachments when only some are malformed', () => {
    const result = normalizeQuickQueryPayload({
      query: 'q',
      attachments: [
        { name: 'bad.png' },
        { name: 'good.png', data: new Uint8Array([7]).buffer },
        null,
      ],
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0].name).toBe('good.png');
  });

  it('keeps the launcher auto-screenshot mark only when it is exactly true', () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const result = normalizeQuickQueryPayload({
      query: 'what is this error',
      attachments: [
        { name: 'Screenshot.png', mimeType: 'image/png', size: 3, data, autoCaptured: true },
        { name: 'chosen.png', mimeType: 'image/png', size: 3, data, autoCaptured: 'yes' },
      ],
    });
    expect(result.attachments?.[0]?.autoCaptured).toBe(true);
    expect(result.attachments?.[1]).not.toHaveProperty('autoCaptured');
  });
});
