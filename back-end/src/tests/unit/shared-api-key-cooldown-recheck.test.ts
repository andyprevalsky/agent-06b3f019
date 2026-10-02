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

const RECHECK_MS = 15 * 1000;

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  passed++;
  process.stdout.write(`  \u2705 ${name}\n`);
}

type CooldownRow = { rateLimitedUntil: Date | null } | null;
const integration = prisma.integration as unknown as {
  findUnique: (...args: unknown[]) => Promise<unknown>;
  upsert: (...args: unknown[]) => Promise<unknown>;
  deleteMany: (...args: unknown[]) => Promise<unknown>;
};
const originals = {
  findUnique: integration.findUnique,
  upsert: integration.upsert,
  deleteMany: integration.deleteMany,
  now: Date.now,
};

let now = 1_800_000_000_000;
let storedRow: CooldownRow = null;
let reads = 0;

const readStoredRow = async (): Promise<CooldownRow> => {
  reads++;
  return storedRow;
};
Date.now = () => now;
integration.findUnique = readStoredRow;
integration.upsert = async (args: unknown) => {
  const { create } = args as { create: { rateLimitedUntil: Date } };
  storedRow = { rateLimitedUntil: create.rateLimitedUntil };
  return {};
};
integration.deleteMany = async () => {
  storedRow = null;
  return { count: 0 };
};

const keys = [
  {
    name: 'GPT',
    reset: async () => __clearGptApiKeyCooldownCache(),
    mark: markGptApiKeyOnCooldown,
    isOnCooldown: isGptApiKeyOnCooldown,
  },
  {
    name: 'Anthropic',
    reset: __resetAnthropicApiKeyCooldown,
    mark: markAnthropicApiKeyOnCooldown,
    isOnCooldown: isAnthropicApiKeyOnCooldown,
  },
];

async function main(): Promise<void> {
  for (const key of keys) {
    await test(`${key.name}: a cooldown cleared in the DB is honored after the recheck interval`, async () => {
      await key.reset();
      await key.mark('insufficient_quota');
      assert.equal(await key.isOnCooldown(), true);
      storedRow = null;
      now += RECHECK_MS + 1;
      assert.equal(await key.isOnCooldown(), false, 'a cleared row must lift the local cooldown');
    });

    await test(`${key.name}: a cooled key reads the DB at most once per recheck interval`, async () => {
      await key.reset();
      await key.mark('insufficient_quota');
      reads = 0;
      for (let i = 0; i < 5; i++) assert.equal(await key.isOnCooldown(), true);
      assert.equal(reads, 0, 'a fresh mark needs no read');
      now += RECHECK_MS + 1;
      for (let i = 0; i < 5; i++) assert.equal(await key.isOnCooldown(), true);
      assert.equal(reads, 1, 'one read per recheck interval while the row stays cooled');
    });

    await test(`${key.name}: a DB read in flight cannot drop a newer mark`, async () => {
      await key.reset();
      storedRow = null;
      let releaseRead!: (row: CooldownRow) => void;
      integration.findUnique = async () => {
        reads++;
        return new Promise((resolve) => {
          releaseRead = resolve;
        });
      };
      try {
        const staleRead = key.isOnCooldown();
        await key.mark('insufficient_quota');
        releaseRead(null);
        assert.equal(await staleRead, true, 'an older read must keep the new mark');
        assert.equal(await key.isOnCooldown(), true);
      } finally {
        integration.findUnique = readStoredRow;
      }
    });
  }
  process.stdout.write(`\nshared API key cooldown recheck unit tests: ${passed} passed\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    Date.now = originals.now;
    integration.findUnique = originals.findUnique;
    integration.upsert = originals.upsert;
    integration.deleteMany = originals.deleteMany;
    await prisma.$disconnect();
  });
