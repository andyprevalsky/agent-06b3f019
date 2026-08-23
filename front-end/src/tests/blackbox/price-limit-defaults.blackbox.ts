import { describe, expect, it } from 'vitest';

import {
  computeDefaultPriceLimitCents,
  MAX_DEFAULT_PRICE_LIMIT_CENTS,
} from '@/lib/priceLimitDefaults';

describe('computeDefaultPriceLimitCents', () => {
  it('uses remaining credits when below the $10 cap', () => {
    expect(computeDefaultPriceLimitCents(3.25)).toBe(325);
  });

  it('caps at $10 for larger balances', () => {
    expect(computeDefaultPriceLimitCents(42)).toBe(MAX_DEFAULT_PRICE_LIMIT_CENTS);
  });

  it('floors at 1 cent for empty accounts', () => {
    expect(computeDefaultPriceLimitCents(0)).toBe(1);
  });
});
