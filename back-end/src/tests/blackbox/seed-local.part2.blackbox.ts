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

function readRepoFile(path: string): string {
  return readFileSync(resolve(__dirname, '../../../../', path), 'utf8');
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

  assert(
    browserState.includes('remote.browserProviderProfile'),
    'expected production browserProviderProfile read'
  );
  assert(
    browserState.includes('tx.browserProviderProfile'),
    'expected local browserProviderProfile write'
  );

  for (const model of ['cookieBundle', 'steelSessionAuth']) {
    // Readers take (where, page) since the browser-auth seed was made paged —
    // an unpaged whole-table read of the multi-MB origin blobs OOM-killed every
    // bench guest. Still asserts the reader is wired to the production model
    // and that browser-state sync goes through the scoped reader.
    assert(
      source.includes(`${model}: (where, page) => remote.${model}.findMany`),
      `expected production ${model} reader`
    );
    assert(
      browserState.includes(`scopedRemoteBrowserAuth.${model}(`),
      `expected scoped production ${model} read`
    );
    assert(
      browserState.includes(`local.${model}`) || browserState.includes(`tx.${model}`),
      `expected local ${model} write`
    );
  }
});

test('browser-context seed uses a cross-version projection before production migration', async () => {
  const source = readSeedLocalSource();
  const browserContextStart = source.indexOf("'Browser Context'");
  const browserProfilesStart = source.indexOf("'Browser Provider Profiles'", browserContextStart);
  const browserContextSync = source.slice(browserContextStart, browserProfilesStart);

  assert(browserContextStart > 0, 'expected the Browser Context sync step');
  assert(browserProfilesStart > browserContextStart, 'expected the provider-profile sync after it');
  assert(
    browserContextSync.includes('select: {'),
    'expected an explicit projection so a newly generated client never selects unmigrated columns'
  );
  for (const stableColumn of ['id: true', 'userId: true', 'contextId: true']) {
    assert(
      browserContextSync.includes(stableColumn),
      `expected the cross-version BrowserContext projection to include ${stableColumn}`
    );
  }
  assert(
    !browserContextSync.includes('preferredBrowserConfig: true'),
    'production-only seed reads must not request the new preference before its migration deploys'
  );
});

test('waitlist account sync uses the tested natural-identity boundary', async () => {
  const source = readSeedLocalSource();
  const waitlistStart = source.indexOf("await syncTable('Waitlist'");
  const waitlistEnd = source.indexOf('throwBrowserAuthSyncFailures', waitlistStart);
  const waitlistSync = source.slice(waitlistStart, waitlistEnd);

  assert(waitlistStart > 0, 'expected the Waitlist sync step');
  assert(
    waitlistSync.includes('syncWaitlistAccounts(remote.user, local.user, phones)'),
    'expected Waitlist accounts to use the tested User natural-identity boundary'
  );
  assert(
    !waitlistSync.includes('upsertById(local.user'),
    'Waitlist account refresh must not bypass User natural-identity reconciliation'
  );
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

test('email-credentials-only seed mode syncs integrations and email rows then returns', async () => {
  const source = readSeedLocalSource();
  const flag = source.indexOf("process.argv.includes('--email-credentials-only')");
  const branch = source.indexOf('if (EMAIL_CREDENTIALS_ONLY)');
  const integrations = source.indexOf('await syncEmailIntegrations()', branch);
  const emailRows = source.indexOf("await syncTable('Email Credentials'", branch);
  const remoteFind = source.indexOf('remote.emailIntegrationCredential.findMany', emailRows);
  const remap = source.indexOf('remapEmailCredentialIntegrationIds', emailRows);
  const branchReturn = source.indexOf('return;', remoteFind);
  const toolsBranch = source.indexOf("await syncTable('Tools'", branchReturn);

  assert(flag > 0, 'expected a dedicated --email-credentials-only CLI flag');
  assert(branch > flag, 'expected email-credentials-only branch after flag declaration');
  assert(
    integrations > branch,
    'expected email-only integrations sync inside email-credentials-only'
  );
  assert(emailRows > integrations, 'expected EmailIntegrationCredential sync after integrations');
  assert(remoteFind > emailRows, 'expected prod email credential rows to be fetched');
  assert(
    remap > remoteFind && remap < branchReturn,
    'expected remote→local integrationId remapping before credential upsert'
  );
  assert(branchReturn > remoteFind, 'expected email-credentials-only branch to return immediately');
  assert(
    toolsBranch > branchReturn,
    'expected email-credentials-only mode to return before the full seed graph'
  );
  assert(
    source.includes('name: { in: [...EMAIL_INTEGRATION_NAMES] }'),
    'expected email-credentials-only to scope integrations to Gmail/Yahoo'
  );
  assert(
    !/await syncTable\('Integrations',\s*syncIntegrations\)/.test(
      source.slice(branch, branchReturn)
    ),
    'email-credentials-only must not call full syncIntegrations (compute-token churn)'
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

test('compute-token-only sync fails closed without an explicit source database', async () => {
  const source = readSeedLocalSource();
  const modeFlag = source.indexOf("process.argv.includes('--compute-tokens-only')");
  const sourceVariable = source.indexOf('const COMPUTE_TOKEN_SOURCE_DATABASE_URL');
  const failClosed = source.indexOf(
    'if (COMPUTE_TOKENS_ONLY && !COMPUTE_TOKEN_SOURCE_DATABASE_URL)'
  );
  const envRead = source.indexOf('dotenv.parse(readFileSync(envPath))');
  const clients = source.indexOf('const remote = new PrismaClient');

  assert(sourceVariable > modeFlag, 'expected the explicit compute-token source variable');
  assert(failClosed > sourceVariable, 'expected compute-token mode to reject a missing source');
  assert(failClosed < envRead, 'expected rejection before any .env fallback can be read');
  assert(failClosed < clients, 'expected rejection before database clients are created');
  assert(
    source.includes('refusing to fall back to .env'),
    'expected the failure to explain the protected boundary'
  );
});

test('missing-Codex bypass warning reports the usable Claude count', async () => {
  const source = readSeedLocalSource();
  const bypass = source.indexOf("process.env.SEED_ALLOW_MISSING_GPT_CODE === '1'");
  const warning = source.indexOf('usable claude_code, 0 usable gpt_code', bypass);

  assert(bypass > 0, 'expected the explicit missing-Codex bypass');
  assert(warning > bypass, 'expected its warning to report the usable Claude count');
});

test('missing-Claude bypass requires the caller-validated Anthropic fallback opt-in', async () => {
  const source = readSeedLocalSource();
  const zeroClaude = source.indexOf('if (usableClaudeCodeCount === 0)');
  const rateLimitedBypass = source.indexOf('rateLimitedClaudeCodeCount > 0', zeroClaude);
  const bypass = source.indexOf("process.env.SEED_ALLOW_MISSING_CLAUDE_CODE === '1'", zeroClaude);
  const keyValidation = source.indexOf('process.env.ANTHROPIC_API_KEY?.trim()', bypass);
  const emptyKeyFailure = source.indexOf(
    'SEED_ALLOW_MISSING_CLAUDE_CODE=1 requires a non-empty ANTHROPIC_API_KEY',
    keyValidation
  );
  const warning = source.indexOf('caller-validated', bypass);
  const fallback = source.indexOf('ANTHROPIC_API_KEY fallback', warning);
  const strictFailure = source.indexOf(
    "throw new Error('No usable claude_code integrations after sync')",
    bypass
  );

  assert(zeroClaude > 0, 'expected an explicit zero-Claude availability check');
  assert(
    rateLimitedBypass > zeroClaude && rateLimitedBypass < bypass,
    'expected rate-limited Claude rows to proceed before the missing-Claude opt-in'
  );
  assert(bypass > zeroClaude, 'expected an explicit missing-Claude opt-in');
  assert(keyValidation > bypass, 'expected the fallback to validate the Anthropic API key');
  assert(emptyKeyFailure > keyValidation, 'expected an empty Anthropic API key to fail closed');
  assert(warning > emptyKeyFailure, 'expected validation before the fallback warning');
  assert(fallback > warning, 'expected the runtime replacement to be the Anthropic API key');
  assert(
    strictFailure > fallback,
    'expected missing Claude OAuth to fail closed without the opt-in'
  );
});

test('rate-limited Claude Code integrations do not hard-fail compute-token sync', async () => {
  const source = readSeedLocalSource();
  const inspector = source.indexOf('async function inspectClaudeCodeIntegrations');
  const gptInspector = source.indexOf('async function inspectGptCodeIntegrations');
  const zeroClaude = source.indexOf('if (usableClaudeCodeCount === 0)');
  const rateLimitedBypass = source.indexOf('rateLimitedClaudeCodeCount > 0', zeroClaude);
  const warning = source.indexOf(
    'present but rate-limited by an external quota',
    rateLimitedBypass
  );
  const strictFailure = source.indexOf(
    "throw new Error('No usable claude_code integrations after sync')",
    rateLimitedBypass
  );

  assert(inspector > 0, 'expected a Claude Code availability inspector');
  assert(gptInspector > 0, 'expected the GPT inspector this mirrors');
  assert(rateLimitedBypass > zeroClaude, 'expected an explicit rate-limited Claude bypass');
  assert(warning > rateLimitedBypass, 'expected the rate-limited Claude path to warn loudly');
  assert(
    strictFailure > warning,
    'expected genuinely missing Claude OAuth to stay fail-closed after the rate-limit bypass'
  );
});

test('compute-token sync can require GPT without requiring Claude OAuth', async () => {
  const source = readSeedLocalSource();
  const parser = source.indexOf('function parseComputeTokenRequiredTypes');
  const env = source.indexOf('SEED_REQUIRE_COMPUTE_TOKEN_TYPES', parser);
  const zeroClaude = source.indexOf('if (usableClaudeCodeCount === 0)');
  const gptOnlyBypass = source.indexOf("!COMPUTE_TOKEN_REQUIRED_TYPES.has('claude')", zeroClaude);
  const gptOnlyWarning = source.indexOf('this run requires GPT compute only', gptOnlyBypass);
  const keyValidation = source.indexOf('process.env.ANTHROPIC_API_KEY?.trim()', gptOnlyWarning);
  const strictFailure = source.indexOf(
    "throw new Error('No usable claude_code integrations after sync')",
    gptOnlyWarning
  );

  assert(parser > 0, 'expected a parser for required compute token types');
  assert(env > parser, 'expected required token types to be read from env');
  assert(gptOnlyBypass > zeroClaude, 'expected GPT-only sync to bypass missing Claude rows');
  assert(gptOnlyWarning > gptOnlyBypass, 'expected GPT-only bypass to be explicit in logs');
  assert(
    keyValidation > gptOnlyWarning,
    'expected Anthropic fallback validation to apply only after the GPT-only bypass'
  );
  assert(
    strictFailure > keyValidation,
    'expected missing Claude to stay fail-closed when Claude remains required'
  );
});

test('compute-token sync any-mode accepts Claude Code OR Codex', async () => {
  const source = readSeedLocalSource();
  const anyHelper = source.indexOf('function requireAnyComputeTokenType');
  const anyParser = source.indexOf("value.toLowerCase() === 'any'");
  const anyBranch = source.indexOf('if (requireAnyComputeTokenType())');
  const eitherOk = source.indexOf('usableClaudeCodeCount > 0 || usableGptCodeCount > 0', anyBranch);
  const eitherFailure = source.indexOf(
    "throw new Error('No usable claude_code or gpt_code integrations after sync')",
    anyBranch
  );

  assert(anyHelper > 0, 'expected an explicit any-mode helper');
  assert(anyParser > 0, 'expected parseComputeTokenRequiredTypes to accept any');
  assert(anyBranch > anyHelper, 'expected sync to branch on any-mode');
  assert(eitherOk > anyBranch, 'expected any-mode to accept either provider');
  assert(
    eitherFailure > eitherOk,
    'expected any-mode to fail only when both providers are missing'
  );
});

test('synthetic benchmark compute access uses the isolated pool without changing ownership', async () => {
  const source = readSeedLocalSource();
  const optIn = source.indexOf('SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS');
  const helper = source.indexOf('async function poolRequiredDevComputeTokensForSyntheticUsers');
  const isolationGuard = source.indexOf('if (!ISOLATED_BENCHMARK_RUN)', helper);
  const ownerBoundary = source.indexOf('userId: DEV_USER_ID', helper);
  const requiredNames = source.indexOf('COMPUTE_TOKEN_REQUIRED_TYPES', helper);
  const poolUpdate = source.indexOf('data: { poolingEnabled: true }', helper);
  const syncCall = source.indexOf('const count = await syncIntegrations()', helper);
  const poolCall = source.indexOf(
    'await poolRequiredDevComputeTokensForSyntheticUsers()',
    syncCall
  );

  assert(optIn > 0, 'expected an explicit synthetic-user pool opt-in');
  assert(helper > optIn, 'expected a narrowly named pooling helper');
  assert(isolationGuard > helper, 'expected pooling to fail closed outside isolated benchmarks');
  assert(ownerBoundary > helper, 'expected the integration to retain the dev-user owner');
  assert(requiredNames > helper, 'expected pooling to be limited to required provider types');
  assert(poolUpdate > isolationGuard, 'expected the isolated-stack guard before the pool update');
  assert(poolUpdate > ownerBoundary, 'expected only the local pooling flag to change');
  assert(syncCall > helper, 'expected production-owned integrations to sync first');
  assert(poolCall > syncCall, 'expected isolated pooling only after credential sync');
  assert(
    !source.slice(helper, poolCall).includes('userId: process.env'),
    'synthetic benchmark users must never receive copied integration rows'
  );
});

test('AgentCard launcher scopes the missing-Claude opt-out to non-Claude tasks', async () => {
  const source = readSeedLocalSource();
  const launcher = readRepoFile('scripts/run-agentcard-lifecycle-task.sh');
  const tasks = JSON.parse(readRepoFile('agents/benchmarks/tasks.json')) as Array<{
    name: string;
    requires_claude_code: boolean;
  }>;
  const acceptedTasks = [
    'agent-payment-test-shop',
    'agent-payment-setup-resume',
    'agent-payment-idempotent-abandonment',
    'agent-payment-abandonment',
  ];
  const bypass = source.indexOf(
    "process.env.SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK === '1'"
  );
  const warning = source.indexOf('launcher-scoped non-Claude task', bypass);
  // Both providers are inspected up-front; gpt_code must still fail closed
  // after the Claude-only opt-out (do not short-circuit the GPT branch).
  const gptInspection = source.indexOf('await inspectGptCodeIntegrations()');
  const gptFailClosed = source.indexOf(
    "throw new Error('No usable gpt_code integrations after sync')",
    warning
  );

  assert(bypass > 0, 'expected a distinct non-Claude task opt-out');
  assert(warning > bypass, 'expected the opt-out to explain its narrow contract');
  assert(gptInspection > 0, 'expected gpt_code availability to be inspected');
  assert(gptFailClosed > warning, 'expected gpt_code validation to remain active');
  assert(
    launcher.includes('export SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK=1'),
    'expected the AgentCard launcher to opt into the non-Claude task path'
  );
  assert(
    launcher.includes('export SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS=1'),
    'expected the AgentCard launcher to expose dev compute through the isolated pool'
  );
  for (const taskName of acceptedTasks) {
    const task = tasks.find((candidate) => candidate.name === taskName);
    assert(task !== undefined, `expected ${taskName} in the benchmark catalog`);
    assert(
      task.requires_claude_code === false,
      `expected ${taskName} to remain explicitly non-Claude before using the opt-out`
    );
  }
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
