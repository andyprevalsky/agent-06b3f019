import { describe, expect, it } from 'vitest';

import { getErrorMessage, getErrorMessageOrFallback, toError } from '../../shared/utils/error';

describe('shared error utilities', () => {
  it('normalizes Error, string, serializable, and unserializable values', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain failure')).toBe('plain failure');
    expect(getErrorMessage({ code: 'E_TEST' })).toBe('{"code":"E_TEST"}');

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(getErrorMessage(circular, 'fallback message')).toBe('fallback message');
  });

  it('preserves real Error instances and wraps unknown values as Error objects', () => {
    const original = new Error('already normalized');

    expect(getErrorMessageOrFallback(original, 'fallback message')).toBe('already normalized');
    expect(getErrorMessageOrFallback('not an error', 'fallback message')).toBe('fallback message');
    expect(toError(original)).toBe(original);
    expect(toError({ reason: 'missing token' }).message).toBe('{"reason":"missing token"}');
  });
});
