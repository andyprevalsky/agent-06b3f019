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
import {
  nudgeCardholderRecoveries,
  nudgeCardholderRecovery,
} from '../../providers/agentcard/fund-recovery';
import { AgentCardOrgRuntimeError } from '../../providers/agentcard/org-runtime';
import {
  UNUSED_MINT_SETTLE_POLL_MS,
  UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS,
  paceOrgThrottle,
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

  // treasury-rails 2026-11-13 (occurrence 1dc793d7): the shared sandbox org throttled
  // list_transfers for five attempts 28 s into the 240 s settle wait, and the exhausted 429 failed
  // the deploy gate even though the window refills within a minute.
  const throttled = (tool: string) =>
    new AgentCardOrgRuntimeError(
      `AgentCard Organization MCP rate limit exhausted for ${tool} after 5 attempts; upstream: ` +
        `AgentCard Organization MCP ${tool} is rate limited: ${tool} failed: Too many requests, ` +
        'please try again later',
      429,
      'agentcard_org_mcp_rate_limited',
      { tool }
    );

  await check(
    'an exhausted org throttle waits out one window, then keeps polling THIS transfer',
    async () => {
      const org = fakeOrg();
      const time = clock();
      let reads = 0;
      const transfer = await waitForUnusedMintSettled({
        cardholderId: OWN,
        minReleasedCents: MINT,
        callOrgTool: org.callOrgTool,
        readTransfer: async () => {
          reads += 1;
          if (reads === 2) throw throttled('list_transfers');
          return reads >= 3
            ? { status: 'reclaimed', releasedCents: MINT }
            : { status: 'consumed', releasedCents: 0 };
        },
        // The caller's classifier knows nothing about throttles: the wait owns its own pacing.
        isTransientError: () => false,
        report: () => undefined,
        now: time.now,
        sleep: time.sleep,
      });
      assert.equal(transfer?.status, 'reclaimed');
      assert.equal(reads, 3);
      assert.deepEqual(
        time.state.sleeps,
        [UNUSED_MINT_SETTLE_POLL_MS, UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS],
        'a throttled poll backs off a full org window, not the 8 s poll cadence'
      );
    }
  );

  await check(
    'a throttle that outlasts the settle window still fails, after a bounded number of polls',
    async () => {
      const time = clock();
      let polls = 0;
      await assert.rejects(
        waitForUnusedMintSettled({
          cardholderId: OWN,
          minReleasedCents: MINT,
          callOrgTool: async (tool) => {
            polls += 1;
            throw throttled(tool);
          },
          readTransfer: transferAfter(0),
          isTransientError: () => false,
          report: () => undefined,
          timeoutMs: 240_000,
          now: time.now,
          sleep: time.sleep,
        }),
        (error: unknown) =>
          error instanceof AgentCardOrgRuntimeError &&
          error.code === 'agentcard_org_mcp_rate_limited'
      );
      assert.equal(polls, 5, 'one poll per throttle window across 240 s, then the final one');
      assert.ok(
        time.state.sleeps.every((ms) => ms <= UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS),
        'never sleeps past the deadline'
      );
    }
  );

  await check('a non-throttle org error is not mistaken for backpressure', async () => {
    const time = clock();
    await assert.rejects(
      waitForUnusedMintSettled({
        cardholderId: OWN,
        minReleasedCents: MINT,
        callOrgTool: fakeOrg().callOrgTool,
        readTransfer: async () => {
          throw new AgentCardOrgRuntimeError(
            'AgentCard Organization MCP list_transfers failed: Invalid or expired organization token',
            401,
            'agentcard_org_mcp_unauthorized'
          );
        },
        isTransientError: () => false,
        report: () => undefined,
        now: time.now,
        sleep: time.sleep,
      }),
      /Invalid or expired organization token/
    );
    assert.deepEqual(time.state.sleeps, [], 'fails on the first poll without waiting');
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

  // Deploy #2106 (2026-11-15 03:34Z): ~20 concurrent deploys' treasury reads hit the shared org
  // throttle; the run's read-only get_company_wallet probe got 401 flaps, then exhausted the
  // runtime's 30 s 429 budget and failed the gate before anything was minted.
  const exhaustedThrottle = (retryAfterAtMs?: number) =>
    new AgentCardOrgRuntimeError(
      'AgentCard Organization MCP rate limit exhausted for get_company_wallet after 5 attempts; ' +
        `upstream: Too many requests${retryAfterAtMs === undefined ? '' : ` {"retryAfter":${retryAfterAtMs}}`}`,
      429,
      'agentcard_org_mcp_rate_limited'
    );

  await check(
    'an exhausted org throttle on a read is re-issued after one jittered window',
    async () => {
      const time = clock();
      const budget = { remainingMs: 120_000 };
      let reads = 0;
      const wallet = await paceOrgThrottle(
        async () => {
          reads += 1;
          if (reads === 1) throw exhaustedThrottle();
          return { wallet: 'read' };
        },
        { budget, now: time.now, sleep: time.sleep, random: () => 0.5 }
      );
      assert.deepEqual(wallet, { wallet: 'read' });
      assert.equal(reads, 2, 'exactly one extra read after the wait');
      assert.deepEqual(time.state.sleeps, [UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS * 1.25]);
      assert.equal(budget.remainingMs, 120_000 - 75_000, 'the wait is charged to the run budget');
    }
  );

  await check('an advertised throttle reset is honored before the re-read', async () => {
    const time = clock();
    const budget = { remainingMs: 120_000 };
    let reads = 0;
    await paceOrgThrottle(
      async () => {
        reads += 1;
        if (reads === 1) throw exhaustedThrottle(time.now() + 7_000);
        return 'ok';
      },
      { budget, now: time.now, sleep: time.sleep, random: () => 0.25 }
    );
    assert.deepEqual(time.state.sleeps, [7_000 + 250 + 250]);
  });

  await check(
    'a throttle beyond the shared budget still fails with the original error',
    async () => {
      const time = clock();
      const budget = { remainingMs: 120_000 };
      const error = exhaustedThrottle();
      let reads = 0;
      await assert.rejects(
        paceOrgThrottle(
          async () => {
            reads += 1;
            throw error;
          },
          { budget, now: time.now, sleep: time.sleep }
        ),
        (thrown) => thrown === error
      );
      assert.deepEqual(time.state.sleeps, [60_000, 60_000], 'never more than the budget');
      assert.equal(reads, 3);
      assert.equal(budget.remainingMs, 0);
      const late = exhaustedThrottle(time.now() + 1_000);
      await assert.rejects(
        paceOrgThrottle(
          async () => {
            throw late;
          },
          { budget: { remainingMs: 500 }, now: time.now, sleep: time.sleep }
        ),
        (thrown) => thrown === late,
        'an advertised reset that does not fit is not raced'
      );
      assert.equal(time.state.sleeps.length, 2);
    }
  );

  await check('a non-throttle error is never re-issued by the pacer', async () => {
    const time = clock();
    let reads = 0;
    const error = new AgentCardOrgRuntimeError('boom', 500, 'agentcard_org_mcp_error');
    await assert.rejects(
      paceOrgThrottle(
        async () => {
          reads += 1;
          throw error;
        },
        { budget: { remainingMs: 120_000 }, now: time.now, sleep: time.sleep }
      ),
      (thrown) => thrown === error
    );
    assert.equal(reads, 1);
    assert.deepEqual(time.state.sleeps, []);
  });

  await check(
    'a residual sweep round reads open recoveries once for every cardholder',
    async () => {
      const org = fakeOrg({
        recoveries: [
          { id: 'rcv_held', cardholder_id: 'ch_2', status: 'requested', amount_cents: 70 },
        ],
      });
      const nudges = await nudgeCardholderRecoveries([OWN, 'ch_2', 'ch_3'], org.callOrgTool);
      assert.deepEqual(
        org.calls.map((call) => call.tool),
        ['list_recoveries', 'recover_funds', 'recover_funds'],
        'one org-wide read instead of one per cardholder'
      );
      assert.deepEqual(
        nudges.map((nudge) => (nudge instanceof Error ? 'refused' : nudge.kind)),
        ['requested', 'coalesced', 'requested']
      );
    }
  );

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} agentcard settle coalesce test(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write('\nAll agentcard settle coalesce tests passed\n');
}

void main();
