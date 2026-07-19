#!/usr/bin/env tsx

import { syncRowsWithConcurrency } from '../../../scripts/seed-local-helpers';

async function main() {
  const rows = Array.from({ length: 120 }, (_, id) => ({ id }));
  let active = 0;
  let peak = 0;
  const count = await syncRowsWithConcurrency(rows, 25, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
  });

  if (count !== rows.length) {
    throw new Error(`expected ${rows.length} synced rows, got ${count}`);
  }
  if (peak > 25) {
    throw new Error(`expected at most 25 concurrent writes, observed ${peak}`);
  }

  console.log('PASS message-sized seed batches respect the local database concurrency budget');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
