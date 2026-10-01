#!/usr/bin/env tsx

import assert from 'node:assert';
import { resolveFiatSource } from '../../providers/agentcard/org-wallet-fiat';
import { fiatPullEnabled } from '../../providers/agentcard/org-wallet-topup';

// The old scheduled Brex-to-Coinbase rail was removed. Keep its owning test
// path to prove that an old environment flag cannot restart bank transfers.
function main(): void {
  const previous = process.env.COINBASE_FLOAT_REPLENISH_ENABLED;
  try {
    for (const value of [undefined, '0', '1']) {
      if (value === undefined) delete process.env.COINBASE_FLOAT_REPLENISH_ENABLED;
      else process.env.COINBASE_FLOAT_REPLENISH_ENABLED = value;
      assert.strictEqual(fiatPullEnabled(), false);
      assert.strictEqual(resolveFiatSource(), undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.COINBASE_FLOAT_REPLENISH_ENABLED;
    else process.env.COINBASE_FLOAT_REPLENISH_ENABLED = previous;
  }
}

main();
