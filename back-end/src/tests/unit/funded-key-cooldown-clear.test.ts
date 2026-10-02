#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import {
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import {
  __clearGptApiKeyCooldownCache,
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
} from '../../providers/gptCredentials';
import { prisma } from '../../providers/database';

const RECHECK_MS = 15_000;

interface CooldownRow {
  rateLimitedUntil: Date | null;
}

interface FundedKeyCooldown {
  label: string;
  reset: () => Promise<void> | void;
  isOnCooldown: () => Promise<boolean>;
  mark: (reason: string) => Promise<void>;
}

const integration = prisma.integration as unknown as {
  findUnique: (...args: unknown[]) => Promise<unknown>;
  upsert: (...args: unknown[]) => Promise<unknown>;
  deleteMany: (...args: unknown[]) => Promise<unknown>;
};

let sharedRow: CooldownRow | null = null;
let readCount = 0;
let clock = 0;
let holdNextRead: ((row: CooldownRow | null) => void) | null = null;
let holdReads = false;

async function assertStaleReadCannotClearMark(key: FundedKeyCooldown): Promise<void> {
  sharedRow = null;
  await key.reset();
  holdReads = true;
  const staleRead = key.isOnCooldown();
  holdReads = false;
  await key.mark('insufficient_quota');
  assert.ok(holdNextRead !== null, `${key.label}: the pre-mark read must be in flight`);
  holdNextRead(null);
  holdNextRead = null;
  assert.equal(await staleRead, true, `${key.label}: an older DB read must keep the new mark`);
  assert.equal(await key.isOnCooldown(), true, `${key.label}: the next request skips the key`);
}

async function assertCooldownClearPropagates(key: FundedKeyCooldown): Promise<void> {
  sharedRow = null;
  await key.reset();
  readCount = 0;

  await key.mark('insufficient_quota');
  assert.ok(sharedRow !== null, `${key.label}: marking must persist the shared cooldown`);
  clock += 1_000;
  assert.equal(await key.isOnCooldown(), true, `${key.label}: a fresh mark is authoritative`);
  clock += 5_000;
  assert.equal(await key.isOnCooldown(), true, `${key.label}: still cooled inside the window`);
  assert.equal(readCount, 0, `${key.label}: a fresh mark must not re-read the database`);

  // Another backend instance, an operator, or a test cleanup clears the row.
  sharedRow = null;
  clock += RECHECK_MS + 1_000;
  assert.equal(
    await key.isOnCooldown(),
    false,
    `${key.label}: a cleared shared cooldown must release the key within one recheck interval`
  );
  assert.equal(readCount, 1, `${key.label}: re-validation costs one read per recheck interval`);

  // A cooldown marked elsewhere still reaches this process on the next recheck.
  sharedRow = { rateLimitedUntil: new Date(clock + 30 * 60 * 1000) };
  clock += RECHECK_MS + 1_000;
  assert.equal(await key.isOnCooldown(), true, `${key.label}: a remote mark must be honored`);
  clock += 1_000;
  assert.equal(await key.isOnCooldown(), true, `${key.label}: cached between rechecks`);
  assert.equal(readCount, 2, `${key.label}: cached reads must stay off the database`);
}

async function main(): Promise<void> {
  const originalFindUnique = integration.findUnique;
  const originalUpsert = integration.upsert;
  const originalDeleteMany = integration.deleteMany;
  const originalNow = Date.now;
  clock = originalNow();
  Date.now = () => clock;
  integration.findUnique = async () => {
    readCount++;
    if (!holdReads) return sharedRow;
    return new Promise((resolve) => {
      holdNextRead = resolve;
    });
  };
  integration.upsert = async (...args: unknown[]) => {
    const { update } = args[0] as { update: CooldownRow };
    sharedRow = { rateLimitedUntil: update.rateLimitedUntil };
    return sharedRow;
  };
  integration.deleteMany = async () => {
    sharedRow = null;
    return { count: 1 };
  };

  const keys: FundedKeyCooldown[] = [
    {
      label: 'GPT_API_KEY',
      reset: __clearGptApiKeyCooldownCache,
      isOnCooldown: isGptApiKeyOnCooldown,
      mark: markGptApiKeyOnCooldown,
    },
    {
      label: 'ANTHROPIC_API_KEY',
      reset: __resetAnthropicApiKeyCooldown,
      isOnCooldown: isAnthropicApiKeyOnCooldown,
      mark: markAnthropicApiKeyOnCooldown,
    },
  ];
  try {
    for (const key of keys) {
      await assertCooldownClearPropagates(key);
      await assertStaleReadCannotClearMark(key);
    }
    process.stdout.write(
      'Funded key cooldowns: a cleared shared row releases every process; stale reads keep new marks\n'
    );
  } finally {
    Date.now = originalNow;
    integration.findUnique = originalFindUnique;
    integration.upsert = originalUpsert;
    integration.deleteMany = originalDeleteMany;
    __clearGptApiKeyCooldownCache();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
