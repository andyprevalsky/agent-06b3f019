import assert from 'node:assert/strict';

import {
  computeDefaultPriceLimitCents,
  MAX_DEFAULT_PRICE_LIMIT_CENTS,
} from '../../providers/priceLimitDefaults';

assert.equal(computeDefaultPriceLimitCents(1), 100, '$1 remaining -> 100 cents');
assert.equal(computeDefaultPriceLimitCents(5.5), 550, '$5.50 remaining -> 550 cents');
assert.equal(
  computeDefaultPriceLimitCents(25),
  MAX_DEFAULT_PRICE_LIMIT_CENTS,
  'large balance caps at $10'
);
assert.equal(computeDefaultPriceLimitCents(0), 1, 'zero credits floors at 1 cent');
assert.equal(computeDefaultPriceLimitCents(-3), 1, 'negative credits floors at 1 cent');
