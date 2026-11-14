#!/usr/bin/env tsx
import { assertNewUserFixtureCli } from './setup-benchmark-new-user-payment.cases';
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
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
  requireSandboxV2FixtureUserId,
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
  assertNewUserFixtureCli(path.resolve(__dirname, '../../..'));
  for (const value of [undefined, '', '  ', 'ch_legacy']) {
    assert.throws(
      () => requireSandboxV2FixtureUserId(value),
      /BENCHMARK_AGENTCARD_V2_USER_ID is required/
    );
  }
  assert.equal(requireSandboxV2FixtureUserId(' usr_connected_sandbox '), 'usr_connected_sandbox');
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
    const liveGuard = path.join(folder, 'live-fixture-preload.cjs');
    const eventsFile = path.join(folder, 'live-fixture-events.jsonl');
    writeFileSync(
      liveGuard,
      String.raw`
      const Module = require('node:module');
      const fs = require('node:fs');
      const path = require('node:path');
      const root = process.cwd();
      const localRequire = Module.createRequire(path.join(root, 'package.json'));
      const scenario = process.env.FIXTURE_SCENARIO;
      const record = (kind, details={}) => fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({kind,...details}) + '\n');
      const put = (name, value) => { const id = localRequire.resolve(name); const m = new Module(id); m.loaded = true; m.exports = value; require.cache[id] = m; };
      const file = relative => path.join(root, 'src/providers', relative);
      global.fetch = () => { throw new Error('Unexpected real network'); };
      require('node:net').Socket.prototype.connect = () => { throw new Error('Unexpected real database/network'); };
      const client = {
        user: { upsert: async () => { record('user-write'); return {}; } },
        credit: { aggregate: async () => ({_sum:{amountCents:100000}}), create: async () => { record('credit-write'); } },
        toolUsage: { aggregate: async () => ({_sum:{totalCostCents:0}}) },
        subscription: { findUnique: async () => scenario === 'default-new' ? null : ({stripeCustomerId:scenario === 'default-resume'?'cus_new_live':'cus_owned_live'}), upsert: async args => { record('subscription-write', {customer:args.update.stripeCustomerId,livemode:args.update.stripeLivemode}); return {}; } },
        integration: { findMany: async () => [], upsert: async () => { record('integration-write'); return {}; } },
        $queryRaw: async () => [{locked:1}], $transaction: async fn => fn(client), $disconnect: async () => {},
      };
      const prisma = localRequire('@prisma/client');
      put('@prisma/client', {...prisma, PrismaClient: class { constructor(){return client;} }});
      put(file('database.ts'), {prisma:client, runTransactionWithRetry:async fn => fn(client)});
      put(file('agentcard/store.ts'), {
        getV2ConnectedUserId: async id => { if(id !== process.env.BENCHMARK_USER_ID) throw new Error('Wrong Rose fixture user'); record('v2-binding-read'); return scenario === 'missing' ? undefined : 'usr_connected_live'; },
        saveOrgCardholderId: async () => { record('legacy-binding-write'); },
        saveV2ConnectedUserId: async () => { record('v2-binding-write'); },
      });
      put(file('agentcard/api-v2.ts'), {
        AgentCardV2Error: class extends Error {},
        agentCardV2Request: async (method, resource) => {
          if (method !== 'GET') throw new Error('Fixture readiness must be read-only');
          record(resource);
          if (resource === '/api/v2/company_wallet') return {livemode: scenario !== 'sandbox', default_funds_source: scenario === 'onramp' ? 'onramp' : 'company_flow'};
          if (resource === '/api/v2/kyc?user_id=usr_connected_live') return {status: scenario === 'pending' ? 'pending' : scenario === 'rejected' ? 'rejected' : 'approved'};
          throw new Error('Unexpected provider request');
        },
      });
      put(file('agentcard/org-onboarding.ts'), {getOrgCardholderVerificationStatus:async () => {record('legacy-mcp'); return 'approved';}});
      put(file('agentcard/org-runtime.ts'), {callOrgTool:async () => {record('legacy-mcp'); return {structuredContent:{wallet:{livemode:true,balance_cents:50000,committed_cents:0,available_cents:50000}}};}});
      const Stripe = localRequire('stripe');
      class FakeStripe {
        constructor(){
          const kind=scenario.replace(/^default-/, '');
          const replaced=['new','deleted','resource-missing'].includes(kind);
          const expectedCustomer=replaced||kind==='resume'?'cus_new_live':'cus_owned_live';
          const customer=id=>({id,livemode:kind!=='wrong-mode',deleted:false,
            metadata:kind==='missing-metadata'?undefined:{userId:kind==='foreign-customer'?'foreign':process.env.BENCHMARK_USER_ID,fixture:kind==='wrong-fixture'?'unrelated':'agent-payment-production-lifecycle'},
            invoice_settings:{default_payment_method:kind==='hosted-setup'||kind==='attached'||replaced?null:'pm_saved_live'}});
          this.customers = {
            retrieve:async id=>{
              record('stripe-customer-read');
              if(id==='cus_owned_live'&&kind==='deleted')return{id,deleted:true};
              if(id==='cus_owned_live'&&kind==='resource-missing')throw new Stripe.errors.StripeInvalidRequestError({code:'resource_missing',type:'invalid_request_error',message:'missing'});
              if(kind==='lookup-error')throw new Error('temporary customer lookup failure');
              if(kind==='lookup-auth')throw new Stripe.errors.StripeAuthenticationError({message:'no access'});
              return customer(kind==='wrong-id'?'cus_foreign':id);
            },
            create:async input=>{
              if(input.metadata.userId!==process.env.BENCHMARK_USER_ID||input.metadata.fixture!=='agent-payment-production-lifecycle')throw new Error('new customer ownership missing');
              record('stripe-customer-create');return customer('cus_new_live');
            },
            update:async(id,input)=>{
              if(id!==expectedCustomer||input.invoice_settings.default_payment_method!=='pm_attached')throw new Error('wrong default payment method owner');
              record('stripe-default-update');return customer(id);
            },
          };
          this.paymentMethods = {list:async input=>{
            if(input.customer!==expectedCustomer)throw new Error('wrong saved-card owner');
            return{data:kind==='attached'?[{id:'pm_attached'}]:[]};
          }};
          this.checkout = {sessions:{create:async input=>{
            if(input.mode!=='setup'||input.customer!==expectedCustomer||input.amount||input.line_items)throw new Error('wrong hosted setup scope');
            record('stripe-setup-link',{customer:input.customer,mode:input.mode});return{url:'https://billing.example.test/setup'};
          }}};
        }
      }
      FakeStripe.errors = Stripe.errors;
      put('stripe', FakeStripe);
    `
    );
    for (const scenario of [
      'missing',
      'sandbox',
      'onramp',
      'pending',
      'rejected',
      'foreign-customer',
      'hosted-setup',
      'ready',
      'default-foreign-customer',
      'default-missing-metadata',
      'default-wrong-fixture',
      'default-wrong-mode',
      'default-wrong-id',
      'default-lookup-error',
      'default-lookup-auth',
      'default-ready',
      'default-new',
      'default-deleted',
      'default-resource-missing',
      'default-hosted-setup',
      'default-resume',
      'default-attached',
    ]) {
      writeFileSync(eventsFile, '');
      const live = spawnSync(
        process.execPath,
        [
          '--require',
          liveGuard,
          '--import',
          'tsx',
          'scripts/setup-benchmark-payment.ts',
          '--live',
          ...(scenario.startsWith('default-') ? [] : ['--stripe-customer-id', 'cus_owned_live']),
        ],
        {
          cwd: path.resolve(__dirname, '../../..'),
          env: {
            ...process.env,
            FIXTURE_SCENARIO: scenario,
            FIXTURE_EVENTS: eventsFile,
            BENCHMARK_USER_ID: BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID,
            BENCHMARK_AGENTCARD_V2_USER_ID: '',
            STRIPE_SECRET_KEY: 'sk_live_fixture',
            AGENTCARD_ORG_OAUTH_CLIENT_ID: 'fixture_client_id_long_enough',
            AGENTCARD_ORG_OAUTH_CLIENT_SECRET: 'fixture_secret_long_enough',
            AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE: '',
            AGENTCARD_ORG_OAUTH_CLIENT_SECRET_LIVE: '',
            BENCHMARK_AGENTCARD_CARDHOLDER_ID: 'legacy_cardholder_long_enough',
          },
          timeout: 10000,
          encoding: 'utf8',
        }
      );
      const events = readFileSync(eventsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      assert(events.includes('v2-binding-read'), 'CLI must check its current-client binding');
      const expectedPrefix = [
        'v2-binding-read',
        ...(scenario === 'missing' ? [] : ['/api/v2/company_wallet']),
        ...(['missing', 'sandbox', 'onramp'].includes(scenario)
          ? []
          : ['/api/v2/kyc?user_id=usr_connected_live']),
      ];
      assert.deepEqual(events.slice(0, expectedPrefix.length), expectedPrefix);
      if (scenario === 'missing')
        assert.match(live.stderr, /normal signed live AgentCard connection/);
      if (['sandbox', 'onramp'].includes(scenario))
        assert.match(live.stderr, /provider-verified live credentials and company_flow/);
      if (['pending', 'rejected'].includes(scenario))
        assert.match(live.stderr, /requires approved KYC/);
      if (['ready', 'default-ready', 'default-resume', 'default-attached'].includes(scenario)) {
        assert.equal(live.status, 0, live.stderr);
        assert(events.includes('subscription-write'));
        assert(
          !events.some((kind) => /binding-write|integration-write|legacy-mcp/.test(kind)),
          'live provisioning preserves existing integrations and never uses MCP readiness'
        );
      } else if (
        [
          'hosted-setup',
          'default-hosted-setup',
          'default-new',
          'default-deleted',
          'default-resource-missing',
        ].includes(scenario)
      ) {
        assert.equal(live.status, 1);
        assert.match(live.stderr, /https:\/\/billing\.example\.test\/setup/);
        assert(
          events.includes('subscription-write'),
          'billing customer must be persisted for the hosted setup retry'
        );
        assert(events.includes('stripe-setup-link'));
      } else {
        assert.equal(
          live.status,
          1,
          `unsafe ${scenario} fixture must be rejected; observed events: ${events.join(',')}`
        );
        assert(
          !events.some(
            (kind) =>
              kind.endsWith('-write') ||
              ['stripe-customer-create', 'stripe-default-update', 'stripe-setup-link'].includes(
                kind
              )
          ),
          `unsafe ${scenario} fixture must not write`
        );
      }
      const entries = readFileSync(eventsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              customer?: string;
              livemode?: boolean;
              mode?: string;
            }
        );
      const expectedCustomer = [
        'default-new',
        'default-deleted',
        'default-resource-missing',
        'default-resume',
      ].includes(scenario)
        ? 'cus_new_live'
        : 'cus_owned_live';
      for (const entry of entries.filter((e) => e.kind === 'subscription-write')) {
        assert.equal(entry.customer, expectedCustomer);
        assert.equal(entry.livemode, true);
      }
      for (const entry of entries.filter((e) => e.kind === 'stripe-setup-link')) {
        assert.equal(entry.customer, expectedCustomer);
        assert.equal(entry.mode, 'setup');
      }
      if (['default-new', 'default-deleted', 'default-resource-missing'].includes(scenario))
        assert.equal(events.filter((e) => e === 'stripe-customer-create').length, 1);
      if (scenario === 'default-resume')
        assert.ok(
          !events.includes('stripe-customer-create') && !events.includes('stripe-setup-link'),
          'hosted completion reuses exact customer and saved card'
        );
      assert.doesNotMatch(live.stderr, /Unexpected real/);
    }
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
          BENCHMARK_AGENTCARD_V2_USER_ID: '',
          DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/no_help_db',
        },
        timeout: 10000,
        encoding: 'utf8',
      }
    );
    assert.match(output, /Usage: setup-benchmark-payment/);
    assert.match(output, /--agentcard-cardholder-id/);
    assert.match(output, /Sandbox v2 requires BENCHMARK_AGENTCARD_V2_USER_ID/);
    for (const id of ['', 'ch_legacy']) {
      const missingV2 = spawnSync(
        process.execPath,
        ['--require', guard, '--import', 'tsx', 'scripts/setup-benchmark-payment.ts'],
        {
          cwd: path.resolve(__dirname, '../../..'),
          env: { ...process.env, BENCHMARK_AGENTCARD_V2_USER_ID: id },
          timeout: 10000,
          encoding: 'utf8',
        }
      );
      assert.equal(missingV2.status, 1);
      assert.match(missingV2.stderr, /BENCHMARK_AGENTCARD_V2_USER_ID is required/);
      assert.doesNotMatch(missingV2.stderr, /attempted network|attempted provider/);
    }
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
          BENCHMARK_AGENTCARD_V2_USER_ID: '',
          DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/no_help_db',
        },
        timeout: 10000,
        encoding: 'utf8',
      }
    );
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /complete AgentCard LIVE credential pair/);
    assert.doesNotMatch(incomplete.stderr, /attempted network|attempted provider/);
    const sandboxMappingLive = spawnSync(
      process.execPath,
      ['--require', guard, '--import', 'tsx', 'scripts/setup-benchmark-payment.ts', '--live'],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env, BENCHMARK_AGENTCARD_V2_USER_ID: 'usr_sandbox_fixture' },
        timeout: 10000,
        encoding: 'utf8',
      }
    );
    assert.equal(sandboxMappingLive.status, 1);
    assert.match(sandboxMappingLive.stderr, /--live refuses BENCHMARK_AGENTCARD_V2_USER_ID/);
    assert.doesNotMatch(sandboxMappingLive.stderr, /attempted network|attempted provider/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  process.stdout.write(
    'PASS benchmark payment --live v2 admission, no-write failures, billing ownership and hosted setup guards\n'
  );
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
