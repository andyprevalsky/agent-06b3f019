#!/usr/bin/env tsx

// Source-structure invariants for scripts/seed-local.ts: sync-mode branching,
// failure-deferral ordering, and transient-failure retry wiring. Database-level
// behavior tests for the shared credential-sync helpers live in
// seed-local.blackbox.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readSeedLocalSource(): string {
  return readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
}

test('full sync defers browser-auth failure until later tables finish', async () => {
  const source = readSeedLocalSource();
  const fullSyncCollector = source.indexOf('const browserAuthSyncFailures: Error[] = [];');
  const collectedBrowserSync = source.indexOf(
    'await syncBrowserAuthForCurrentMode(browserAuthSyncFailures);'
  );
  const laterTable = source.indexOf("await syncTable('Goal Blueprints'");
  const deferredFailure = source.indexOf('throwBrowserAuthSyncFailures(browserAuthSyncFailures);');
  const credentialsOnlyBranch = source.indexOf('if (CREDENTIALS_ONLY)');
  const failFastBrowserSync = source.indexOf(
    'await syncBrowserAuthWithRetries();',
    credentialsOnlyBranch
  );

  assert(fullSyncCollector > 0, 'expected full sync to collect browser-auth failures');
  assert(
    collectedBrowserSync > fullSyncCollector,
    'expected full sync to pass its failure collector to browser-auth sync'
  );
  assert(laterTable > collectedBrowserSync, 'expected later full-sync tables after browser auth');
  assert(
    deferredFailure > laterTable,
    'expected collected browser-auth failures to throw only after later tables finish'
  );
  assert(
    failFastBrowserSync > credentialsOnlyBranch && failFastBrowserSync < fullSyncCollector,
    'expected credentials-only sync to remain fail-fast within each attempt'
  );
});

test('credentials-only sync retries transient failures with bounded attempts', async () => {
  const source = readSeedLocalSource();
  const attemptsConstant = source.indexOf('const BROWSER_AUTH_SYNC_ATTEMPTS = ');
  const retryHelper = source.indexOf('async function syncBrowserAuthWithRetries()');
  const retryLoop = source.indexOf(
    'for (let attempt = 1; attempt <= BROWSER_AUTH_SYNC_ATTEMPTS; attempt++)',
    retryHelper
  );
  const perAttemptSync = source.indexOf('await syncBrowserAuthForCurrentMode();', retryLoop);
  const backoff = source.indexOf('await sleep(500 * 2 ** (attempt - 1));', retryLoop);
  const exhaustedThrow = source.indexOf(
    'Browser auth sync failed after ${BROWSER_AUTH_SYNC_ATTEMPTS} attempts',
    retryLoop
  );
  const credentialsOnlyBranch = source.indexOf('if (CREDENTIALS_ONLY)');
  const retriedCall = source.indexOf('await syncBrowserAuthWithRetries();', credentialsOnlyBranch);

  assert(attemptsConstant > 0, 'expected a bounded browser-auth retry attempt constant');
  assert(retryHelper > attemptsConstant, 'expected a browser-auth retry helper');
  assert(retryLoop > retryHelper, 'expected the retry helper to loop up to the attempt bound');
  assert(
    perAttemptSync > retryLoop,
    'expected each retry attempt to run the fail-fast browser-auth sync (no failure collector)'
  );
  assert(backoff > retryLoop, 'expected exponential backoff between retry attempts');
  assert(
    exhaustedThrow > retryLoop,
    'expected the retry helper to throw once every attempt is exhausted'
  );
  assert(
    retriedCall > credentialsOnlyBranch,
    'expected the credentials-only branch to sync browser auth through the retry helper'
  );
});

test('browser-auth sync includes every durable credential reference', async () => {
  const source = readSeedLocalSource();
  const browserStateStart = source.indexOf('async function syncBrowserState');
  const browserStateEnd = source.indexOf('function sleep', browserStateStart);
  const browserState = source.slice(browserStateStart, browserStateEnd);

  for (const model of ['browserProviderProfile', 'cookieBundle', 'steelSessionAuth']) {
    assert(browserState.includes(`remote.${model}`), `expected production ${model} read`);
    assert(
      browserState.includes(`local.${model}`) || browserState.includes(`tx.${model}`),
      `expected local ${model} write`
    );
  }
});

test('passkeys-only seed mode never enters browser state or password sync', async () => {
  const source = readSeedLocalSource();
  const flag = source.indexOf("process.argv.includes('--passkeys-only')");
  const branch = source.indexOf('if (PASSKEYS_ONLY)');
  const passkeySync = source.indexOf(
    'await syncPasskeysOnly(undefined, { authoritative: true });',
    branch
  );
  const branchReturn = source.indexOf('return;', passkeySync);
  const credentialsOnlyBranch = source.indexOf('if (CREDENTIALS_ONLY)');

  assert(flag > 0, 'expected a dedicated --passkeys-only CLI flag');
  assert(branch > flag, 'expected passkeys-only branch after flag declaration');
  assert(passkeySync > branch, 'expected passkeys-only branch to sync passkeys');
  assert(branchReturn > passkeySync, 'expected passkeys-only branch to return immediately');
  assert(
    source.includes("'Stale Local Passkeys'") &&
      source.includes('local.passkeyCredential.deleteMany'),
    'expected passkeys-only mode to remove stale local passkeys'
  );
  assert(
    credentialsOnlyBranch > branchReturn,
    'expected passkeys-only mode to return before browser state/password sync'
  );
});

test('seed-local rejects conflicting exclusive sync modes before creating database clients', async () => {
  const source = readSeedLocalSource();
  const validation = source.indexOf('if (requestedSeedModes.length > 1)');
  const clients = source.indexOf('const remote = new PrismaClient');

  assert(validation > 0, 'expected mutually exclusive seed-mode validation');
  assert(clients > validation, 'expected seed-mode validation before database client creation');
  assert(
    source.includes('Seed modes are mutually exclusive; received'),
    'expected conflicting flags to be named in the failure'
  );
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (err) {
      failed++;
      process.stderr.write(`FAIL ${name}\n`);
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }
  process.stdout.write(`\nResults: ${tests.length - failed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
