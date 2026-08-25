import assert from 'node:assert/strict';

import {
  DEFAULT_TASK_PRICE_LIMIT_CENTS,
  resolvePriceLimitCents,
} from '../../providers/priceLimitDefaults';

assert.equal(DEFAULT_TASK_PRICE_LIMIT_CENTS, 1000);
assert.equal(resolvePriceLimitCents(undefined), 1000);
assert.equal(resolvePriceLimitCents(0), 1000);
assert.equal(resolvePriceLimitCents(250), 250);
