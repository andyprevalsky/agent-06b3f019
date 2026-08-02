import { describe, expect, it } from 'vitest';

import { isLocalTemporalAddress } from '../../providers/temporal';

describe('Temporal local address detection', () => {
  it.each(['localhost:7233', '127.0.0.1:7233', '[::1]:7233', '::1'])(
    'accepts loopback address %s',
    (address) => {
      expect(isLocalTemporalAddress(address)).toBe(true);
    }
  );

  it('keeps Temporal Cloud on authenticated TLS', () => {
    expect(isLocalTemporalAddress('rose.tmprl.cloud:7233')).toBe(false);
  });
});
