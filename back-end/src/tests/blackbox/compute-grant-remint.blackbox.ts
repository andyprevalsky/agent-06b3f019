#!/usr/bin/env tsx
/**
 * Re-mint orchestration: trigger -> mint -> retry.
 *
 * The behaviours asserted here are the ones that only show up under real
 * conditions -- a grant dying while many agents are mid-flight, a connection
 * that is itself dead, a throttle masquerading as a failure. Each test names the
 * production failure it prevents.
 */

import {
  ComputeGrantReminter,
  type ComputeGrantRecord,
  type GrantMinter,
  type GrantStore,
} from '../../providers/computeGrantRemint';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const REVOKED = '{"error":{"message":"OAuth access token has been revoked."}}';

interface Harness {
  reminter: ComputeGrantReminter;
  mintCalls: () => number;
  mintArgs: () => Array<{ userId: string; accountId: string }>;
  connectionStates: () => string[];
  deadGrants: () => string[];
  advance: (ms: number) => void;
}

function harness(opts: { mint?: GrantMinter['mint']; cooldownMs?: number } = {}): Harness {
  let clock = 1_000_000;
  let mints = 0;
  const mintArgs: Array<{ userId: string; accountId: string }> = [];
  const states: string[] = [];
  const dead: string[] = [];
  let seq = 0;

  const store: GrantStore = {
    async getActiveGrant() {
      return null;
    },
    async markGrantDead(grantId) {
      dead.push(grantId);
    },
    async saveGrant(rec): Promise<ComputeGrantRecord> {
      seq += 1;
      return { ...rec, grantId: `grant-${seq}` };
    },
    async setConnectionState(_u, _p, _a, state) {
      states.push(state);
    },
  };

  const minter: GrantMinter = {
    async mint(userId, _provider, accountId) {
      mints += 1;
      mintArgs.push({ userId, accountId });
      if (opts.mint !== undefined) return opts.mint(userId, _provider, accountId);
      return { accessToken: `sk-ant-oat01-minted-${mints}` };
    },
  };

  return {
    reminter: new ComputeGrantReminter({
      store,
      minter,
      now: () => clock,
      cooldownMs: opts.cooldownMs ?? 60_000,
    }),
    mintCalls: () => mints,
    mintArgs: () => mintArgs,
    connectionStates: () => states,
    deadGrants: () => dead,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const revokedFailure = (over: Partial<{ accountId: string; userId: string }> = {}) => ({
  userId: over.userId ?? 'user-1',
  provider: 'claude' as const,
  accountId: over.accountId ?? 'acct-1',
  grantId: 'grant-old',
  status: 401,
  body: REVOKED,
});

test('revoked grant -> mints a replacement and returns a usable token', async () => {
  const h = harness();
  const out = await h.reminter.onCompletionFailure(revokedFailure());
  assert(out.status === 'reminted', `expected reminted, got ${out.status} (${out.reason})`);
  assert(
    out.accessToken?.startsWith('sk-ant-oat01-minted') === true,
    'must return the new token so the caller can retry'
  );
  assert(h.deadGrants().includes('grant-old'), 'the dead grant must be marked dead');
});

test('REGRESSION: a 429 never mints (a throttle must not cost a grant)', async () => {
  const h = harness();
  const out = await h.reminter.onCompletionFailure({
    userId: 'user-1',
    provider: 'claude',
    accountId: 'acct-1',
    status: 429,
    body: '{"error":{"message":"weekly usage limit. Resets 2026-08-25"}}',
  });
  assert(out.status === 'not_revoked', `429 must not re-mint, got ${out.status}`);
  assert(h.mintCalls() === 0, `429 minted ${h.mintCalls()} grants; must be 0`);
});

test('payment/quota failures never mint (a new grant would fail identically)', async () => {
  const h = harness();
  for (const f of [
    { status: 402, body: '' },
    { status: 400, body: '{"error":{"message":"credit balance is too low"}}' },
  ]) {
    const out = await h.reminter.onCompletionFailure({
      userId: 'user-1',
      provider: 'claude',
      accountId: 'acct-1',
      ...f,
    });
    assert(out.status === 'not_revoked', `${f.status} must not re-mint, got ${out.status}`);
  }
  assert(h.mintCalls() === 0, 'payment failures must never mint');
});

test('SCALE: 50 concurrent agents on one dead grant collapse to exactly ONE mint', async () => {
  // When a grant dies, every in-flight agent fails at once. Minting per failure
  // would issue 50 grants and hammer the consent endpoint.
  const h = harness();
  const results = await Promise.all(
    Array.from({ length: 50 }, () => h.reminter.onCompletionFailure(revokedFailure()))
  );
  assert(h.mintCalls() === 1, `expected exactly 1 mint, got ${h.mintCalls()}`);
  const usable = results.filter((r) => r.accessToken !== undefined);
  assert(
    usable.length === 50,
    `all 50 callers must receive a usable token, only ${usable.length} did`
  );
});

test('SCALE: different accounts do NOT serialise behind each other', async () => {
  // A single global lock would make one user's outage stall every other user.
  const h = harness();
  await Promise.all([
    h.reminter.onCompletionFailure(revokedFailure({ accountId: 'acct-A' })),
    h.reminter.onCompletionFailure(revokedFailure({ accountId: 'acct-B' })),
    h.reminter.onCompletionFailure(revokedFailure({ userId: 'user-2', accountId: 'acct-C' })),
  ]);
  assert(h.mintCalls() === 3, `each account needs its own mint, got ${h.mintCalls()}`);
});

test('minting is driven by the ACCOUNT, never by the dead grant', async () => {
  // A dead token must not be able to block its own replacement.
  const h = harness();
  await h.reminter.onCompletionFailure(revokedFailure({ accountId: 'acct-xyz' }));
  const args = h.mintArgs();
  assert(args.length === 1 && args[0].accountId === 'acct-xyz', 'mint must receive the account id');
});

test('a dead CONNECTION surfaces needs_reconnect rather than looping', async () => {
  const h = harness({
    mint: async () => {
      throw new Error('consent screen never rendered (session cookie expired)');
    },
  });
  const out = await h.reminter.onCompletionFailure(revokedFailure());
  assert(out.status === 'needs_reconnect', `expected needs_reconnect, got ${out.status}`);
  assert(
    h.connectionStates().includes('needs_reconnect'),
    'the account must be flagged so the FE chip can prompt a reconnect'
  );
});

test('BOUNDED: a failing mint cools down instead of spinning', async () => {
  // Without this, a permanently broken connection turns every agent failure
  // into another mint attempt -- an unbounded loop against the provider.
  const h = harness({
    mint: async () => {
      throw new Error('upstream 500');
    },
    cooldownMs: 60_000,
  });
  const first = await h.reminter.onCompletionFailure(revokedFailure());
  assert(first.status === 'mint_failed', `expected mint_failed, got ${first.status}`);

  for (let i = 0; i < 10; i += 1) {
    const again = await h.reminter.onCompletionFailure(revokedFailure());
    assert(
      again.status === 'cooldown',
      `attempt ${i + 2} should be cooled down, got ${again.status}`
    );
  }
  assert(h.mintCalls() === 1, `cooldown must suppress retries; saw ${h.mintCalls()} mints`);
});

test('cooldown expires so a recovered connection heals itself', async () => {
  let fail = true;
  const h = harness({
    mint: async () => {
      if (fail) throw new Error('upstream 500');
      return { accessToken: 'sk-ant-oat01-recovered' };
    },
    cooldownMs: 60_000,
  });
  assert(
    (await h.reminter.onCompletionFailure(revokedFailure())).status === 'mint_failed',
    'first fails'
  );
  assert(
    (await h.reminter.onCompletionFailure(revokedFailure())).status === 'cooldown',
    'second cools down'
  );

  h.advance(61_000);
  fail = false;
  const healed = await h.reminter.onCompletionFailure(revokedFailure());
  assert(healed.status === 'reminted', `after cooldown it must retry, got ${healed.status}`);
  assert(healed.accessToken === 'sk-ant-oat01-recovered', 'must return the recovered token');
});

test('a successful re-mint marks the connection healthy again', async () => {
  const h = harness();
  await h.reminter.onCompletionFailure(revokedFailure());
  assert(
    h.connectionStates().includes('connected'),
    'a successful mint must clear any needs_reconnect state'
  );
});

test('codex terminal refresh codes drive a re-mint too', async () => {
  // The canary proved forked Codex lineages die with refresh_token_reused, so
  // this is the real production signal, not a hypothetical.
  const h = harness();
  const out = await h.reminter.onCompletionFailure({
    userId: 'user-1',
    provider: 'codex',
    accountId: 'acct-1',
    status: 401,
    body: '{"error":{"code":"refresh_token_reused"}}',
  });
  assert(out.status === 'reminted', `codex revocation must re-mint, got ${out.status}`);
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute-grant re-mint orchestration\n');
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      failures.push(t.name);
      console.log(`  FAIL  ${t.name}\n        ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('compute-grant-remint')) {
  void main();
}
