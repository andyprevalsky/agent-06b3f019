#!/usr/bin/env tsx
/**
 * Unit tests for the two `--live` blast-radius guards in scripts/setup-benchmark-payment.ts.
 *
 *   1. `resolveBenchmarkUserId` — `--user-id=` yields `''`, which the old `??` chain KEPT (an empty
 *      string is not nullish). `''` clears `assertUserMatchesMode` and `assertNonAdminBenchmarkUser`
 *      (it is neither a reserved identity nor an admin), so the fixture upserted a User and
 *      Subscription row keyed on `''` — in the PRODUCTION database under `--live`.
 *
 *   2. `assertLiveOrgWallet` / `requireLiveOrgWallet` — a `verified` KYC status only proves the
 *      cardholder resolves, not that the ambient org credentials are production. Sandbox
 *      credentials resolve a sandbox cardholder to `verified`, and that id would then be persisted
 *      into the production fixture. `get_company_wallet`'s `livemode` is the mode signal.
 *
 * Importing the script is side-effect free: its `main()` is behind `require.main === module`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BENCHMARK_PAYMENT_LIFECYCLE_USER_ID } from '../../domains/purchases/config';
// The production identity is owned by providers/benchmarkPaymentIdentity; importing
// it from purchases/config yielded `undefined`, which made every assertion below
// compare against undefined instead of the real id.
import { BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID } from '../../providers/benchmarkPaymentIdentity';
import {
  configureLiveFixtureEnvironment,
  assertLiveOrgWallet,
  requireLiveOrgWallet,
  resolveBenchmarkUserId,
} from '../../../scripts/setup-benchmark-payment';

// Explicit live aliases and cardholder selection must not inherit the local sandbox pair.
const environment = {
  AGENTCARD_ORG_OAUTH_CLIENT_ID: 'generic-id',
  AGENTCARD_ORG_OAUTH_CLIENT_SECRET: 'generic-secret',
  AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE: ' live-id ',
  AGENTCARD_ORG_OAUTH_CLIENT_SECRET_LIVE: ' live-secret ',
  BENCHMARK_AGENTCARD_CARDHOLDER_ID: 'old-holder',
};
configureLiveFixtureEnvironment(' dedicated-holder ', environment);
assert.equal(environment.AGENTCARD_ORG_OAUTH_CLIENT_ID, 'live-id');
assert.equal(environment.AGENTCARD_ORG_OAUTH_CLIENT_SECRET, 'live-secret');
assert.equal(environment.BENCHMARK_AGENTCARD_CARDHOLDER_ID, 'dedicated-holder');
const generic = {
  AGENTCARD_ORG_OAUTH_CLIENT_ID: 'prod-id',
  AGENTCARD_ORG_OAUTH_CLIENT_SECRET: 'prod-secret',
};
configureLiveFixtureEnvironment(undefined, generic);
assert.deepEqual(generic, {
  AGENTCARD_ORG_OAUTH_CLIENT_ID: 'prod-id',
  AGENTCARD_ORG_OAUTH_CLIENT_SECRET: 'prod-secret',
});
for (const partial of [
  { AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE: 'id' },
  { AGENTCARD_ORG_OAUTH_CLIENT_SECRET_LIVE: 'secret' },
]) {
  const before = { ...partial };
  assert.throws(
    () => configureLiveFixtureEnvironment('holder', partial),
    /complete.*LIVE|LIVE.*pair/
  );
  assert.deepEqual(partial, before, 'reject incomplete pair before mutating environment');
}
assert.throws(() => configureLiveFixtureEnvironment('', {}), /cardholder/);

// ── 1. Empty --user-id must never become the seeded identity ──

// `--user-id=` (the exact CodeRabbit repro): blank is absent, so the mode default wins.
assert.equal(
  resolveBenchmarkUserId(['', undefined, BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID]),
  BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID
);
// A blank exported BENCHMARK_USER_ID is equally absent.
assert.equal(
  resolveBenchmarkUserId([undefined, '', BENCHMARK_PAYMENT_LIFECYCLE_USER_ID]),
  BENCHMARK_PAYMENT_LIFECYCLE_USER_ID
);
// Whitespace-only is blank too, and a real id is trimmed rather than passed through raw.
assert.equal(resolveBenchmarkUserId(['   ', ' user-b ', 'default']), 'user-b');
// An explicit id still wins over the environment and the default.
assert.equal(resolveBenchmarkUserId(['user-a', 'user-b', 'default']), 'user-a');
// Nothing usable anywhere must throw rather than resolve to '' — the row-keyed-on-empty hazard.
assert.throws(
  () => resolveBenchmarkUserId(['', '  ', undefined]),
  /Refusing to seed the payment fixture with an empty user id/
);

// ── 2. --live must prove the org credentials are live, not merely KYC-verified ──

const liveWallet = {
  livemode: true,
  balanceCents: 50_000,
  committedCents: 0,
  availableCents: 50_000,
};
const sandboxWallet = { ...liveWallet, livemode: false };

assert.doesNotThrow(() => assertLiveOrgWallet(liveWallet));
assert.throws(() => assertLiveOrgWallet(sandboxWallet), /SANDBOX AgentCard org credentials/);

async function walletResponse(livemode: boolean): Promise<unknown> {
  return {
    structuredContent: {
      wallet: {
        livemode,
        balance_cents: 50_000,
        committed_cents: 0,
        available_cents: 50_000,
      },
    },
  };
}

async function main(): Promise<void> {
  const calls: string[] = [];
  const liveResult = await requireLiveOrgWallet(async (toolName) => {
    calls.push(toolName);
    return walletResponse(true);
  });
  assert.deepEqual(calls, ['get_company_wallet']);
  assert.equal(liveResult.livemode, true);
  assert.equal(liveResult.availableCents, 50_000);

  await assert.rejects(
    () => requireLiveOrgWallet(async () => walletResponse(false)),
    /SANDBOX AgentCard org credentials/
  );

  // A wallet payload the org MCP never resolved must fail loudly, not read as "not live".
  await assert.rejects(
    () => requireLiveOrgWallet(async () => ({})),
    /returned no structured wallet/
  );

  const folder = mkdtempSync(path.join(tmpdir(), 'payment-help-'));
  try {
    const guard = path.join(folder, 'forbid-network.cjs');
    writeFileSync(
      guard,
      "require('node:net').Socket.prototype.connect = function () { throw new Error('Help attempted network/database connection'); }; global.fetch = () => { throw new Error('Help attempted provider call'); };\n"
    );
    const output = execFileSync(
      process.execPath,
      [
        '--require',
        guard,
        '--import',
        'tsx',
        'scripts/setup-benchmark-payment.ts',
        '--live',
        '--help',
      ],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/no_help_db',
        },
        timeout: 10000,
        encoding: 'utf8',
      }
    );
    assert.match(output, /Usage: setup-benchmark-payment/);
    assert.match(output, /--agentcard-cardholder-id/);
    const incomplete = spawnSync(
      process.execPath,
      ['--require', guard, '--import', 'tsx', 'scripts/setup-benchmark-payment.ts', '--live'],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE: 'fixture-live-id',
          AGENTCARD_ORG_OAUTH_CLIENT_SECRET_LIVE: '',
          DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/no_help_db',
        },
        timeout: 10000,
        encoding: 'utf8',
      }
    );
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /complete AgentCard LIVE credential pair/);
    assert.doesNotMatch(incomplete.stderr, /attempted network|attempted provider/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  process.stdout.write('PASS benchmark payment --live user-id and org-wallet guards\n');
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
