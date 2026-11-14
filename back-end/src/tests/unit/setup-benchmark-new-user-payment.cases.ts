import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Event = { kind: string; [key: string]: unknown };

/** Exercise the actual default CLI entrypoint with every external side effect trapped. */
export function assertNewUserFixtureCli(backendDir: string): void {
  const folder = mkdtempSync(path.join(tmpdir(), 'new-user-v2-fixture-'));
  const preload = path.join(folder, 'preload.cjs');
  const eventsFile = path.join(folder, 'events.jsonl');
  writeFileSync(
    preload,
    String.raw`
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const localRequire = Module.createRequire(path.join(process.cwd(), 'package.json'));
const scenario = process.env.NEWUSER_FIXTURE_SCENARIO;
const record = (kind, extra={}) => fs.appendFileSync(process.env.NEWUSER_FIXTURE_EVENTS, JSON.stringify({kind,...extra})+'\n');
const put = (name, value) => { const id=localRequire.resolve(name); const mod=new Module(id); mod.loaded=true; mod.exports=value; require.cache[id]=mod; };
const source = rel => path.join(process.cwd(), 'src', rel);
global.fetch = () => { throw new Error('UNEXPECTED_REAL_NETWORK'); };
require('node:net').Socket.prototype.connect = () => { throw new Error('UNEXPECTED_REAL_DATABASE_OR_NETWORK'); };
put('dotenv', {config:()=>({parsed:{}})});
const oldConfig = {legacyToken:'keep', orgManaged:true, cardholderId:'cm_original',
  v2Bindings:{client_historical:'usr_previous_mode'}};
const client = {
  subscription:{findUnique:async input => {record('subscription-read',input); return scenario==='subscription-exists'?{id:'sub_existing'}:null;}},
  integration:{upsert:async input => {record('raw-integration-write',input);return {}; }},
  $disconnect:async()=>record('disconnect'),
};
const actualPrisma=localRequire('@prisma/client');
put('@prisma/client',{...actualPrisma,PrismaClient:class{constructor(){return client;}}});
put(source('providers/database.ts'),{prisma:client,runTransactionWithRetry:async fn=>fn(client)});
put(source('providers/agentcard/benchmark-float.ts'),{
  waitOutBenchmarkOrgBackpressure:async fn=>fn(),
  resolveBenchmarkCardholderId:async()=>{record('legacy-mcp-resolve');return 'cm_legacy_holder';},
  ensureBenchmarkOrgCardholder:async id=>{record('legacy-mcp-ensure',{id});},
});
if(scenario==='same-client-remap') oldConfig.v2Bindings[process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID]='usr_original_current';
put(source('providers/agentcard/repo.ts'),{
  bindV2UserExclusively:async(userId,providerUserId,buildConfig,clientId)=>{
    record('exclusive-v2-attempt',{userId,providerUserId,clientId});
    if(scenario==='binding-conflict')return {conflictingUserId:'different-rose-user'};
    if(userId!==process.env.BENCHMARK_USER_ID||providerUserId!=='usr_sandbox_current'||clientId!==process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID)throw new Error('Wrong scoped fixture identity');
    const config=buildConfig(oldConfig);
    record('exclusive-v2-write',{userId,providerUserId,clientId,config});
    return {};
  },
});
put(source('providers/agentcard/api-v2.ts'),{
  agentCardV2Request:async(method,resource)=>{
    record('provider-read',{method,resource});
    if(method!=='GET')throw new Error('AUTOMATIC_CONNECT_OR_PROVIDER_WRITE_FORBIDDEN');
    if(resource==='/api/v2/company_wallet')return {livemode:scenario==='live-wallet'?true:scenario==='unknown-mode'?undefined:false,
      default_funds_source:scenario==='onramp'?'onramp_flow':'company_flow'};
    if(resource==='/api/v2/kyc?user_id=usr_sandbox_current'){
      if(scenario==='not-connected')throw new Error('connection_not_found');
      return {status:scenario==='invalid-kyc'?'unknown':'pending'};
    }
    throw new Error('Unexpected provider resource: '+resource);
  },
});
put('stripe',class{constructor(){record('stripe-api');throw new Error('STRIPE_CALL_FORBIDDEN');}});
`
  );
  function run(scenario: string, overrides: Record<string, string> = {}) {
    writeFileSync(eventsFile, '');
    const result = spawnSync(
      process.execPath,
      ['--require', preload, '--import', 'tsx', 'scripts/setup-benchmark-new-user-payment.ts'],
      {
        cwd: backendDir,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'development',
          BENCHMARK_USER_ID: 'new-user-fixture',
          STRIPE_SECRET_KEY: 'sk_test_fixture',
          DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture_isolated',
          DIRECT_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture_isolated',
          BENCHMARK_AGENTCARD_V2_USER_ID: 'usr_sandbox_current',
          AGENTCARD_ORG_OAUTH_CLIENT_ID: 'client_current_fixture_scope',
          AGENTCARD_ORG_OAUTH_CLIENT_SECRET: 'secret_fixture_scope',
          NEWUSER_FIXTURE_SCENARIO: scenario,
          NEWUSER_FIXTURE_EVENTS: eventsFile,
          ...overrides,
        },
      }
    );
    const events = readFileSync(eventsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event);
    assert.equal(result.signal, null, `${scenario} must finish without a process timeout`);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_REAL_|STRIPE_CALL_FORBIDDEN/);
    return { ...result, events };
  }
  try {
    const ready = run('ready');
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(
      ready.events.filter((event) => event.kind === 'exclusive-v2-write').length,
      1,
      `default CLI must use the shared v2 writer: ${JSON.stringify(ready.events)}`
    );
    assert.equal(
      ready.events.filter(
        (event) => event.kind.startsWith('legacy') || event.kind === 'raw-integration-write'
      ).length,
      0,
      'new-user setup must never resolve a legacy cardholder or replace Integration.config'
    );
    const output = JSON.parse(ready.stdout.trim()) as Record<string, unknown>;
    assert.deepEqual(output, {
      user_id: 'new-user-fixture',
      subscription: null,
      agentcard_v2_user_id: 'usr_sandbox_current',
    });
    const saved = ready.events.find((event) => event.kind === 'exclusive-v2-write')?.config as {
      legacyToken: string;
      v2Bindings: Record<string, string>;
    };
    assert.equal(saved.legacyToken, 'keep');
    assert.equal(saved.v2Bindings.client_historical, 'usr_previous_mode');
    assert.equal(saved.v2Bindings.client_current_fixture_scope, 'usr_sandbox_current');
    assert.deepEqual(
      ready.events
        .filter((event) => event.kind === 'provider-read')
        .map((event) => [event.method, event.resource]),
      [
        ['GET', '/api/v2/company_wallet'],
        ['GET', '/api/v2/kyc?user_id=usr_sandbox_current'],
      ]
    );
    for (const [scenario, overrides] of [
      ['ready', { BENCHMARK_USER_ID: '' }],
      ['ready', { STRIPE_SECRET_KEY: 'sk_live_fixture' }],
      ['ready', { STRIPE_SECRET_KEY: ' sk_test_fixture' }],
      ['ready', { NODE_ENV: 'production' }],
      [
        'ready',
        {
          DATABASE_URL: 'postgresql://fixture:secret@db.example.invalid/fixture',
          BENCHMARK_PAYMENT_ALLOW_REMOTE_DB: 'true',
        },
      ],
      ['ready', { DIRECT_URL: 'postgresql://fixture:secret@db.example.invalid/fixture' }],
      ['ready', { DATABASE_URL: '' }],
      ['ready', { DATABASE_URL: 'invalid-url' }],
      ['ready', { BENCHMARK_AGENTCARD_V2_USER_ID: '' }],
      ['ready', { BENCHMARK_AGENTCARD_V2_USER_ID: 'cm_legacy_holder' }],
      ['ready', { BENCHMARK_AGENTCARD_V2_USER_ID: 'usr_' }],
    ] as Array<[string, Record<string, string>]>) {
      const blocked = run(scenario, overrides);
      assert.equal(
        blocked.status,
        1,
        JSON.stringify({ scenario, overrides, stderr: blocked.stderr, events: blocked.events })
      );
      assert.equal(
        blocked.events.length,
        0,
        'invalid admission must stop before any DB/provider work'
      );
    }
    const paid = run('subscription-exists');
    assert.equal(paid.status, 1);
    assert.match(paid.stderr, /must begin without a subscription/);
    assert.deepEqual(
      paid.events.map((event) => event.kind),
      ['subscription-read', 'disconnect']
    );
    for (const scenario of [
      'live-wallet',
      'unknown-mode',
      'onramp',
      'not-connected',
      'invalid-kyc',
      'binding-conflict',
      'same-client-remap',
    ]) {
      const blocked = run(scenario);
      assert.equal(blocked.status, 1, `${scenario}: ${blocked.stderr}`);
      assert.equal(
        blocked.events.filter((event) => event.kind.endsWith('-write')).length,
        0,
        `${scenario} must not persist a binding or subscription`
      );
      assert.equal(
        blocked.events.some((event) => event.kind.startsWith('legacy')),
        false
      );
    }
    const replay = run('ready');
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(
      replay.events.filter((event) => event.kind === 'exclusive-v2-attempt'),
      ready.events.filter((event) => event.kind === 'exclusive-v2-attempt'),
      'retries must preserve the exact scoped identity'
    );
    process.stdout.write(
      'PASS new-user default CLI v2 binding, no-subscription, mode/local DB and no-write guards\n'
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
