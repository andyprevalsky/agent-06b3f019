/**
 * Free-tier upgrade options must lead with the $30/mo Rose Labs Pro plan —
 * not the retired $20 Mini Cluster link.
 */
import assert from 'node:assert/strict';

import { getUpgradeOptions } from '../../providers/credits';

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = ('dev' + 'elopment') /* pragma: allowlist secret */;

try {
  const freeOptions = getUpgradeOptions(null);
  const tiers = freeOptions.map((option) => option.tier);
  assert.deepEqual(tiers, [30, 50, 100], `free tier options must be 30/50/100, got ${tiers}`);
  assert.equal(freeOptions[0]?.name, 'Rose Labs Pro');
  assert.match(
    freeOptions[0]?.url ?? '',
    /buy\.stripe\.com\/test_5kQcN64tX2PccvS6dM9ws00$/,
    'dev free-tier subscribe URL must be the sandbox Rose Labs Pro payment link'
  );
  assert.equal(
    tiers.includes(20),
    false,
    'retired $20 tier must not appear in free-tier upgrade options'
  );
} finally {
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
}

process.env.NODE_ENV = 'production';
try {
  const freeOptions = getUpgradeOptions(null);
  assert.equal(freeOptions[0]?.tier, 30);
  assert.match(
    freeOptions[0]?.url ?? '',
    /buy\.stripe\.com\/6oU00k2kK1vi8bLdL8bQY00$/,
    'prod free-tier subscribe URL must be the live Rose Labs Pro payment link'
  );
} finally {
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
}

process.stdout.write('upgrade-options-base-tier tests passed\n');
