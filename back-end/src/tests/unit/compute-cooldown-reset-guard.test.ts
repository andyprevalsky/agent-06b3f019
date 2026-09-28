#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { __resetAnthropicApiKeyCooldown } from '../../providers/computeCredentials';

async function main(): Promise<void> {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://example:example@remote.example.com:5432/db';
  try {
    await assert.rejects(__resetAnthropicApiKeyCooldown(), /database host.*not local/);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  process.stdout.write('Test-only cooldown reset refuses a remote database\n');
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
