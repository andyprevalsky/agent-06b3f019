#!/usr/bin/env tsx

/**
 * Unit tests: the unused-mint settle wait must not multiply load on the shared AgentCard org.
 *
 * Every deploy's treasury-rails lane polls its closed card every 8 s. The old poll swept EVERY
 * cardholder in the shared sandbox org (list_cardholders + list_recoveries + one recover_funds
 * per cardholder + list_recoveries), so concurrent deploys multiplied each other's org traffic
 * and pulled each other's residual. Cement: a poll reads open recoveries once, nudges only the
 * card's own cardholder, coalesces on a recovery already in flight (any deploy or production),
 * and THIS card's transfer stays the only success signal. Offline fakes only; no provider or DB.
 */

import assert from 'node:assert/strict';
import { nudgeCardholderRecovery } from '../../providers/agentcard/fund-recovery';
import {
  UNUSED_MINT_SETTLE_POLL_MS,
  waitForUnusedMintSettled,
  type MintTransferObservation,
} from '../../providers/agentcard/unused-mint-settle';

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stderr.write(
      `  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

const OWN = 'ch_benchmark';
const MINT = 1_300;

type Recovery = { id: string; cardholder_id?: string; status: string; amount_cents: number };
type Call = { tool: string; args: Record<string, unknown> };

/** A shared sandbox org: 40 cardholders, open recoveries, live-style `requested` recoveries. */
function fakeOrg(options: { recoveries?: Recovery[]; settleRecoveries?: boolean } = {}) {
  const calls: Call[] = [];
  const recoveries: Recovery[] = [...(options.recoveries ?? [])];
  const callOrgTool = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ tool, args });
    if (tool === 'list_cardholders') {
      return {
        structuredContent: {
          cardholders: Array.from({ length: 40 }, (_, i) => ({ id: i === 0 ? OWN : `ch_${i}` })),
        },
      };
    }
    if (tool === 'list_recoveries') {
      return { structuredContent: { recoveries: recoveries.map((entry) => ({ ...entry })) } };
    }
    if (tool === 'recover_funds') {
      // Provider contract: an open recovery holds the claim; a second request is refused benignly.
      if (
        recoveries.some((r) => r.cardholder_id === args.cardholder_id && r.status !== 'completed')
      ) {
        return { structuredContent: { status: 'error', message: 'insufficient_headroom' } };
      }
      const id = `rcv_${recoveries.length}`;
      const status = options.settleRecoveries === false ? 'requested' : 'completed';
      recoveries.push({
        id,
        cardholder_id: String(args.cardholder_id),
        status,
        amount_cents: 1_300,
      });
      return { structuredContent: { recovery: { id, status, amount_cents: 1_300 } } };
    }
    throw new Error(`unexpected org tool ${tool}`);
  };
  return { calls, recoveries, callOrgTool };
}

function clock() {
  const state = { now: 1_000_000, sleeps: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

/** THIS card's transfer: consumed for `consumedPolls` reads, then reclaimed in full. */
function transferAfter(consumedPolls: number) {
  let reads = 0;
  return async (): Promise<MintTransferObservation> => {
    reads += 1;
    return reads > consumedPolls
      ? { status: 'reclaimed', releasedCents: MINT }
      : { status: 'consumed', releasedCents: 0 };
  };
}

async function main(): Promise<void> {
  await check('a settle poll costs two org calls and touches only its own cardholder', async () => {
    const org = fakeOrg();
    const time = clock();
    const transfer = await waitForUnusedMintSettled({
      cardholderId: OWN,
      minReleasedCents: MINT,
      callOrgTool: org.callOrgTool,
      readTransfer: transferAfter(2),
      isTransientError: () => false,
      report: () => undefined,
      now: time.now,
      sleep: time.sleep,
    });
    assert.equal(transfer?.status, 'reclaimed');
    assert.equal(
      org.calls.filter((call) => call.tool === 'list_cardholders').length,
      0,
      'a settle poll must not enumerate the whole shared org'
    );
    const recovered = org.calls.filter((call) => call.tool === 'recover_funds');
    assert.deepEqual(
      recovered.map((call) => call.args),
      [{ cardholder_id: OWN }, { cardholder_id: OWN }, { cardholder_id: OWN }],
      'only the card cardholder is nudged, with no amount (full residual, retry-safe)'
    );
    assert.equal(org.calls.length, 6, 'three polls x (list_recoveries + recover_funds)');
    assert.deepEqual(time.state.sleeps, [UNUSED_MINT_SETTLE_POLL_MS, UNUSED_MINT_SETTLE_POLL_MS]);
  });

  await check(
    'an open recovery for the cardholder (another deploy) is polled, not re-requested',
    async () => {
      const org = fakeOrg({
        recoveries: [
          { id: 'rcv_other_deploy', cardholder_id: OWN, status: 'requested', amount_cents: 1_300 },
        ],
      });
      const time = clock();
      const lines: string[] = [];
      const transfer = await waitForUnusedMintSettled({
        cardholderId: OWN,
        minReleasedCents: MINT,
        callOrgTool: org.callOrgTool,
        readTransfer: transferAfter(3),
        isTransientError: () => false,
        report: (line) => lines.push(line),
        now: time.now,
        sleep: time.sleep,
      });
      assert.equal(transfer?.status, 'reclaimed');
      assert.equal(org.calls.filter((call) => call.tool === 'recover_funds').length, 0);
      assert.equal(org.calls.length, 4, 'one list_recoveries per poll');
      assert.match(lines.join('\n'), /coalesced on in-flight 1300c/);
    }
  );

  await check(
    'two concurrent deploys on one cardholder request one live recovery between them',
    async () => {
      const org = fakeOrg({ settleRecoveries: false });
      const first = clock();
      const second = clock();
      const wait = (time: ReturnType<typeof clock>) =>
        waitForUnusedMintSettled({
          cardholderId: OWN,
          minReleasedCents: MINT,
          callOrgTool: org.callOrgTool,
          readTransfer: transferAfter(2),
          isTransientError: () => false,
          report: () => undefined,
          now: time.now,
          sleep: time.sleep,
        });
      const a = wait(first);
      // Deploy B's first poll lands after deploy A's request, as on any real schedule.
      while (!org.calls.some((call) => call.tool === 'recover_funds')) await Promise.resolve();
      const [settledA, b] = await Promise.all([a, wait(second)]);
      assert.equal(settledA?.status, 'reclaimed');
      assert.equal(b?.status, 'reclaimed');
      assert.equal(org.calls.filter((call) => call.tool === 'recover_funds').length, 1);
    }
  );

  await check(
    'a foreign recovery yield never settles THIS card; the wait returns the last row',
    async () => {
      const org = fakeOrg({
        recoveries: [
          { id: 'rcv_foreign', cardholder_id: 'ch_7', status: 'completed', amount_cents: 8_792 },
        ],
      });
      const time = clock();
      const lines: string[] = [];
      const transfer = await waitForUnusedMintSettled({
        cardholderId: OWN,
        minReleasedCents: MINT,
        callOrgTool: org.callOrgTool,
        readTransfer: async () => ({ status: 'consumed', releasedCents: 0 }),
        isTransientError: () => false,
        report: (line) => lines.push(line),
        timeoutMs: 24_000,
        now: time.now,
        sleep: time.sleep,
      });
      assert.deepEqual(transfer, { status: 'consumed', releasedCents: 0 });
      assert.equal(time.state.sleeps.length, 3, 'bounded by the in-run wait');
      assert.match(lines.at(-1) ?? '', /not reclaimed within the in-run wait \(4 attempts\)/);
    }
  );

  await check('a refused recovery is evidence; a non-transient org error still fails', async () => {
    const time = clock();
    const refusing = async (tool: string): Promise<unknown> =>
      tool === 'list_recoveries'
        ? { structuredContent: { recoveries: [] } }
        : { isError: true, structuredContent: { message: 'recover_funds failed: unauthorized' } };
    const transfer = await waitForUnusedMintSettled({
      cardholderId: OWN,
      minReleasedCents: MINT,
      callOrgTool: refusing,
      readTransfer: transferAfter(0),
      isTransientError: () => false,
      report: () => undefined,
      now: time.now,
      sleep: time.sleep,
    });
    assert.equal(transfer?.status, 'reclaimed');
    await assert.rejects(
      waitForUnusedMintSettled({
        cardholderId: OWN,
        minReleasedCents: MINT,
        callOrgTool: async () => {
          throw new Error('org auth revoked');
        },
        readTransfer: transferAfter(0),
        isTransientError: () => false,
        report: () => undefined,
        now: time.now,
        sleep: time.sleep,
      }),
      /org auth revoked/
    );
  });

  await check('a transient poll error retries on the same cadence until the deadline', async () => {
    const time = clock();
    let reads = 0;
    const transfer = await waitForUnusedMintSettled({
      cardholderId: OWN,
      minReleasedCents: MINT,
      callOrgTool: fakeOrg().callOrgTool,
      readTransfer: async () => {
        reads += 1;
        if (reads === 1) throw new Error('service unavailable');
        return { status: 'reclaimed', releasedCents: MINT };
      },
      isTransientError: (error) => /unavailable/.test(String(error)),
      report: () => undefined,
      now: time.now,
      sleep: time.sleep,
    });
    assert.equal(transfer?.status, 'reclaimed');
    assert.deepEqual(time.state.sleeps, [UNUSED_MINT_SETTLE_POLL_MS]);
  });

  await check('an unattributed open recovery does not suppress this cardholder', async () => {
    const org = fakeOrg({
      recoveries: [{ id: 'rcv_anon', status: 'requested', amount_cents: 50 }],
    });
    const nudge = await nudgeCardholderRecovery(OWN, org.callOrgTool);
    assert.equal(nudge.kind, 'requested');
    assert.deepEqual(
      org.calls.map((call) => call.tool),
      ['list_recoveries', 'recover_funds']
    );
  });

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} agentcard settle coalesce test(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write('\nAll agentcard settle coalesce tests passed\n');
}

void main();
