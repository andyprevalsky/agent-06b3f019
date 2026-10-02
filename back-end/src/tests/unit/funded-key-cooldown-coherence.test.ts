#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import {
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import { prisma } from '../../providers/database';
import {
  __clearGptApiKeyCooldownCache,
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
} from '../../providers/gptCredentials';

const RECHECK_MS = 15_000;

type CooldownRow = { rateLimitedUntil: Date | null } | null;

interface FundedKeyCooldown {
  name: string;
  reset: () => Promise<void> | void;
  isOnCooldown: () => Promise<boolean>;
  mark: (reason: string) => Promise<void>;
}

const KEYS: FundedKeyCooldown[] = [
  {
    name: 'GPT_API_KEY',
    reset: __clearGptApiKeyCooldownCache,
    isOnCooldown: isGptApiKeyOnCooldown,
    mark: markGptApiKeyOnCooldown,
  },
  {
    name: 'ANTHROPIC_API_KEY',
    reset: __resetAnthropicApiKeyCooldown,
    isOnCooldown: isAnthropicApiKeyOnCooldown,
    mark: markAnthropicApiKeyOnCooldown,
  },
];

const integration = prisma.integration as unknown as {
  findUnique: (...args: unknown[]) => Promise<unknown>;
  upsert: (...args: unknown[]) => Promise<unknown>;
  deleteMany: (...args: unknown[]) => Promise<unknown>;
};

async function withFakeDb(
  fn: (db: { row: CooldownRow; reads: number; clock: { now: number } }) => Promise<void>
): Promise<void> {
  const original = {
    findUnique: integration.findUnique,
    upsert: integration.upsert,
    deleteMany: integration.deleteMany,
    now: Date.now,
  };
  const db = { row: null as CooldownRow, reads: 0, clock: { now: original.now() } };
  Date.now = () => db.clock.now;
  integration.findUnique = async () => {
    db.reads++;
    return db.row;
  };
  integration.upsert = async (args: unknown) => {
    const until = (args as { create: { rateLimitedUntil: Date } }).create.rateLimitedUntil;
    db.row = { rateLimitedUntil: until };
    return {};
  };
  integration.deleteMany = async () => {
    db.row = null;
    return { count: 1 };
  };
  try {
    await fn(db);
  } finally {
    integration.findUnique = original.findUnique;
    integration.upsert = original.upsert;
    integration.deleteMany = original.deleteMany;
    Date.now = original.now;
  }
}

async function testClearedRowReachesAProcessThatMarkedTheKey(key: FundedKeyCooldown) {
  await withFakeDb(async (db) => {
    await key.reset();
    await key.mark('insufficient_quota');
    assert.equal(await key.isOnCooldown(), true, `${key.name}: a fresh mark is cooled`);
    assert.equal(db.reads, 0, `${key.name}: the mark itself is fresh, so no DB read is needed`);

    db.row = null;
    db.clock.now += RECHECK_MS - 1;
    assert.equal(
      await key.isOnCooldown(),
      true,
      `${key.name}: inside the recheck interval the local mark stands`
    );
    assert.equal(db.reads, 0, `${key.name}: no DB read inside the recheck interval`);

    db.clock.now += 1;
    assert.equal(
      await key.isOnCooldown(),
      false,
      `${key.name}: once the shared row is cleared, the marking process must see it within one recheck interval, not after the 30-minute window`
    );
    assert.equal(db.reads, 1, `${key.name}: one DB read per recheck interval`);
  });
}

async function testLongerSharedCooldownIsAdopted(key: FundedKeyCooldown) {
  await withFakeDb(async (db) => {
    await key.reset();
    await key.mark('insufficient_quota');
    const extended = new Date(db.clock.now + 2 * 60 * 60 * 1000);
    db.row = { rateLimitedUntil: extended };
    db.clock.now += 31 * 60 * 1000;
    assert.equal(
      await key.isOnCooldown(),
      true,
      `${key.name}: a longer cooldown written by another instance must be honoured`
    );
  });
}

async function testReadRacingTheMarkCannotClearIt(key: FundedKeyCooldown) {
  await withFakeDb(async (db) => {
    await key.reset();
    db.clock.now += RECHECK_MS;
    let finishRead!: (row: CooldownRow) => void;
    integration.findUnique = async () => {
      db.reads++;
      return new Promise<CooldownRow>((resolve) => {
        finishRead = resolve;
      });
    };
    const staleRead = key.isOnCooldown();
    await key.mark('insufficient_quota');
    finishRead(null);
    assert.equal(
      await staleRead,
      true,
      `${key.name}: a DB read that started before the mark must not clear it`
    );
    assert.equal(await key.isOnCooldown(), true, `${key.name}: the next request stays cooled`);
  });
}

async function main(): Promise<void> {
  try {
    for (const key of KEYS) {
      await testClearedRowReachesAProcessThatMarkedTheKey(key);
      await testLongerSharedCooldownIsAdopted(key);
      await testReadRacingTheMarkCannotClearIt(key);
      process.stdout.write(`${key.name} cooldown: cache stays coherent with the shared row\n`);
    }
  } finally {
    __clearGptApiKeyCooldownCache();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
