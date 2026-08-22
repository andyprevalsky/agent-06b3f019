#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for the 1 user : 1 cardholder : 1 wallet invariant.
 *
 * An AgentCard cardholder owns exactly ONE funding wallet and issues MANY cards from it (one per
 * purchase). Binding two Rose users to the same cardholder therefore makes them share a wallet and
 * spend each other's money.
 *
 * This is not hypothetical. On 2026-07-29 the prod value of BENCHMARK_AGENTCARD_CARDHOLDER_ID was
 * a LIVE cardholder (cmrs8yoi90004l704hm69y7jg), so `setup-benchmark-payment.ts` bound the
 * synthetic fixture user 00000000-0000-4000-8000-000000000107 to a real user's cardholder — and
 * benchmark card mints drew on that real user's float. `saveOrgCardholderId` had no uniqueness
 * check, so the second binding was written silently.
 */

import assert from 'node:assert';
import {
  AgentCardCardholderConflictError,
  saveOrgCardholderId,
  type SaveOrgCardholderDeps,
} from '../../providers/agentcard/store';

const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface Saved {
  userId: string;
  config: Record<string, unknown>;
  connected: boolean;
}

/**
 * In-memory stand-in for repo.ts — keeps these pure unit tests with no database.
 *
 * Mirrors the real contract: ownership check and write are ONE atomic operation
 * (`bindCardholderExclusively`), so the test cannot pass a shape production no longer uses.
 */
function fakeRepo(
  ownersByCardholder: Record<string, string[]>,
  existingConfig: unknown = {}
): {
  deps: SaveOrgCardholderDeps;
  saved: Saved[];
} {
  const saved: Saved[] = [];
  return {
    saved,
    deps: {
      async bindCardholderExclusively(userId, cardholderId, buildConfig) {
        const owners = ownersByCardholder[cardholderId] ?? [];
        const conflicting = owners.find((owner) => owner !== userId);
        if (conflicting !== undefined) return { conflictingUserId: conflicting };
        const config = buildConfig(existingConfig);
        saved.push({ userId, config: config as Record<string, unknown>, connected: true });
        return {};
      },
    },
  };
}

async function main(): Promise<void> {
  console.log('AgentCard cardholder uniqueness (1 user : 1 cardholder : 1 wallet)');

  await check('binds a cardholder that nobody owns yet', async () => {
    const { deps, saved } = fakeRepo({});
    await saveOrgCardholderId('user-a', 'ch_1', deps);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].userId, 'user-a');
    assert.strictEqual(saved[0].config.cardholderId, 'ch_1');
    assert.strictEqual(saved[0].config.orgManaged, true);
    assert.strictEqual(saved[0].connected, true);
  });

  await check(
    're-binding the SAME user to its own cardholder is idempotent, not a conflict',
    async () => {
      const { deps, saved } = fakeRepo({ ch_1: ['user-a'] });
      await saveOrgCardholderId('user-a', 'ch_1', deps);
      assert.strictEqual(saved.length, 1, 'an owner re-binding itself must still write');
    }
  );

  await check('REFUSES to bind a second user to an already-owned cardholder', async () => {
    const { deps, saved } = fakeRepo({ ch_live: ['1f85ff25-real-user'] });
    await assert.rejects(
      () => saveOrgCardholderId('00000000-0000-4000-8000-000000000107', 'ch_live', deps),
      (error: unknown) => {
        assert.ok(
          error instanceof AgentCardCardholderConflictError,
          'should throw AgentCardCardholderConflictError'
        );
        assert.strictEqual(error.cardholderId, 'ch_live');
        assert.strictEqual(error.ownerUserId, '1f85ff25-real-user');
        return true;
      }
    );
    assert.strictEqual(saved.length, 0, 'must not write on conflict');
  });

  await check(
    'reproduces the exact prod incident: benchmark fixture onto a live cardholder',
    async () => {
      // The real ids, so this test names the incident it exists to prevent.
      const { deps, saved } = fakeRepo({
        cmrs8yoi90004l704hm69y7jg: ['1f85ff25-6e29-4c1b-8739-f917bd101a30'],
      });
      await assert.rejects(
        () =>
          saveOrgCardholderId(
            '00000000-0000-4000-8000-000000000107',
            'cmrs8yoi90004l704hm69y7jg',
            deps
          ),
        AgentCardCardholderConflictError
      );
      assert.strictEqual(saved.length, 0);
    }
  );

  await check('a cardholder with no current owner can be bound', async () => {
    const { deps, saved } = fakeRepo({ ch_2: [] });
    await saveOrgCardholderId('user-b', 'ch_2', deps);
    assert.strictEqual(saved.length, 1);
  });

  await check('onboarding scratch keys are cleared on promotion to org-managed', async () => {
    const { deps, saved } = fakeRepo(
      { ch_3: [] },
      {
        onboardingSessionId: 'sess_1',
        onboardingSetupUrl: 'https://example.test/setup',
        onboardingExpiresAt: '2026-01-01T00:00:00Z',
        accessToken: 'keep-me',
      }
    );
    await saveOrgCardholderId('user-c', 'ch_3', deps);
    const written = saved[0].config;
    assert.strictEqual(written.onboardingSessionId, undefined);
    assert.strictEqual(written.onboardingSetupUrl, undefined);
    assert.strictEqual(written.onboardingExpiresAt, undefined);
    assert.strictEqual(written.accessToken, 'keep-me', 'unrelated config must survive');
  });

  // REGRESSION: the check and the write must be ONE atomic operation. The earlier shape read
  // owners, then wrote separately, so two concurrent binds for different users could both observe
  // "unowned" and both succeed — commingling two users onto one wallet. No unique index can catch
  // that after the fact, because the binding lives in a JSON column.
  await check('ownership check and write are a single atomic call', async () => {
    const calls: string[] = [];
    const owners: Record<string, string[]> = { ch_race: [] };
    const deps: SaveOrgCardholderDeps = {
      async bindCardholderExclusively(userId, cardholderId, buildConfig) {
        calls.push(userId);
        // Serialized by the advisory lock in production: the second caller observes the first
        // caller's write. Modelled here by committing before returning.
        const existing = owners[cardholderId] ?? [];
        const conflicting = existing.find((owner) => owner !== userId);
        if (conflicting !== undefined) return { conflictingUserId: conflicting };
        buildConfig({});
        owners[cardholderId] = [...existing, userId];
        return {};
      },
    };
    await saveOrgCardholderId('user-first', 'ch_race', deps);
    await assert.rejects(
      () => saveOrgCardholderId('user-second', 'ch_race', deps),
      AgentCardCardholderConflictError,
      'the second binder must lose once the first has committed'
    );
    assert.deepStrictEqual(calls, ['user-first', 'user-second']);
    assert.deepStrictEqual(owners.ch_race, ['user-first'], 'only one owner may ever be recorded');
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll cardholder uniqueness tests passed.');
}

void main();
