import { describe, expect, it } from 'vitest';

import { DEFAULT_TASK_PRICE_LIMIT_CENTS } from '@/lib/priceLimitDefaults';

describe('DEFAULT_TASK_PRICE_LIMIT_CENTS', () => {
  it('is $10.00', () => {
    expect(DEFAULT_TASK_PRICE_LIMIT_CENTS).toBe(1000);
  });
});
