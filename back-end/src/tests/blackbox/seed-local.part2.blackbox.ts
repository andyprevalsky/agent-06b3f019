#!/usr/bin/env tsx

// Source-structure invariants for scripts/seed-local.ts: sync-mode branching,
// failure-deferral ordering, and transient-failure retry wiring. Database-level
// behavior tests for the shared credential-sync helpers live in
// seed-local.blackbox.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRetryableProbe } from '../../../scripts/retryable-probe';

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
  const integrationProjectionStart = source.indexOf(
    'const PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT = {'
  );
  const integrationProjectionEnd = source.indexOf('} as const;', integrationProjectionStart);
  const integrationProjection = source.slice(integrationProjectionStart, integrationProjectionEnd);
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
    integrationProjection.includes('accountId: true'),
    'expected production integration reads to preserve multi-account identity'
  );
  assert(
    !/await syncTable\('Integrations',\s*syncIntegrations\)/.test(
      source.slice(branch, branchReturn)
    ),
    'email-credentials-only must not call full syncIntegrations (compute-token churn)'
  );
  // Multi-account upserts need accountId, but the stable pre-migration projection
  // must not select it (prod may lack the columns). findProdIntegrations probes
  // and defaults accountId/accountEmail when absent.
  assert(
    source.includes('PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT') &&
      source.includes("accountId: '', accountEmail: null"),
    'email-credentials path must resolve accountId via findProdIntegrations defaults'
  );
});

test('every seed mode hydrates the selected user before dependent writes', async () => {
  const source = readSeedLocalSource();
  const sync = source.indexOf('async function sync()');
  const identity = source.indexOf(
    "await syncRequiredCredentialTable('Seed identity', ensureSeedUserExists)",
    sync
  );
  const computeMode = source.indexOf('if (COMPUTE_TOKENS_ONLY)', sync);
  const emailMode = source.indexOf('if (EMAIL_CREDENTIALS_ONLY)', sync);

  assert(sync > 0, 'expected seed orchestration');
  assert(identity > sync, 'expected selected-user hydration through its bounded retry owner');
  assert(identity < computeMode, 'expected selected-user hydration before compute-token writes');
  assert(identity < emailMode, 'expected selected-user hydration before email-credential writes');
});

test('compute-token cleanup cannot delete integrations owned by unrelated local users', async () => {
  const source = readSeedLocalSource();
  const helperStart = source.indexOf('async function syncIntegrations(');
  const helperEnd = source.indexOf('/** Email providers refreshed', helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert(helperStart > 0 && helperEnd > helperStart, 'expected syncIntegrations helper');
  assert(
    /OR:\s*\[\s*\{\s*userId:\s*SEED_USER_ID\s*\}/.test(helper),
    'expected stale cleanup to target only the selected seed user by default'
  );
  assert(
    /\{\s*userId:\s*\{\s*in:\s*poolUserIds\s*\},\s*poolingEnabled:\s*true\s*\}/.test(helper),
    'expected stale cleanup to target only active pool owners among imported pool users'
  );
});

test('compute-token overlay must not restore AgentCard setup fixtures', async () => {
  // RCA: sibling live-fixture compute-token refresh rewrote production agentcard
  // CONNECTED over agent-payment-setup-resume's local reset, skipping onboarding.
  const source = readSeedLocalSource();
  const helperStart = source.indexOf('async function syncIntegrations(');
  const helperEnd = source.indexOf('/** Email providers refreshed', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  const computeRetry = source.indexOf('async function syncComputeTokensWithRetries');
  const syncCallIdx = source.indexOf(
    'await syncIntegrations({ computeTokensOnly: true })',
    computeRetry
  );
  const computeBody = source.slice(computeRetry, source.indexOf('\n}\n', syncCallIdx));
  const computeBranch = helper.match(
    /computeTokensOnly\s*\?\s*(\{[\s\S]*?\})\s*:\s*(\{[\s\S]*?\})/
  );

  assert(helperStart > 0 && helperEnd > helperStart, 'expected syncIntegrations helper');
  assert(computeRetry > 0, 'expected compute-token retry helper');
  assert(syncCallIdx > computeRetry, 'compute-token refresh must opt into computeTokensOnly');
  assert(
    computeBody.includes('syncIntegrations({ computeTokensOnly: true })'),
    'compute-token refresh must opt into computeTokensOnly'
  );
  assert(computeBranch !== null, 'expected computeTokensOnly ternary on userIntegrations fetch');
  assert(
    /name:\s*\{\s*in:\s*\[\.\.\.COMPUTE_INTEGRATION_NAMES\]\s*\}/.test(computeBranch?.[1] ?? ''),
    'computeTokensOnly branch must filter to claude_code/gpt_code'
  );
  assert(
    /name:\s*\{\s*not:\s*'lantern_people'/.test(computeBranch?.[2] ?? ''),
    'full seed must exclude rotating Lantern grants while ordinary providers retain full-mode coverage'
  );
  assert(
    helper.includes('agentcard-setup') || helper.includes('AgentCard'),
    'helper comment must document why agentcard is excluded from compute overlays'
  );
});

test('email credential seed reads remain compatible before production migration', async () => {
  const source = readSeedLocalSource();
  const projectionStart = source.indexOf('const PROD_EMAIL_CREDENTIAL_COLUMNS = {');
  const projectionEnd = source.indexOf('} as const;', projectionStart);
  const projection = source.slice(projectionStart, projectionEnd);
  const projectionUses = source.match(/select: PROD_EMAIL_CREDENTIAL_COLUMNS/g) ?? [];

  assert(projectionStart > 0, 'expected a stable production email-credential projection');
  assert(projectionEnd > projectionStart, 'expected the projection to be complete');
  for (const stableColumn of [
    'id: true',
    'userId: true',
    'integrationId: true',
    'provider: true',
    'refreshToken: true',
    'email: true',
  ]) {
    assert(
      projection.includes(stableColumn),
      `expected the email-credential projection to include ${stableColumn}`
    );
  }
  assert(
    !projection.includes('state: true') &&
      !projection.includes('lastErrorReason: true') &&
      !projection.includes('lastFailedSyncAt: true'),
    'production seed reads must not request health columns before their migration deploys'
  );
  assert(
    projectionUses.length === 2,
    `both full and email-only seed paths must use the stable projection (found ${projectionUses.length})`
  );
  const remapStart = source.indexOf('function remapEmailCredentialIntegrationIds<');
  const remapEnd = source.indexOf('\n}\n', remapStart);
  const remapHelper = source.slice(remapStart, remapEnd);
  assert(remapStart > 0 && remapEnd > remapStart, 'expected email credential remap helper');
  for (const healthDefault of [
    "state: 'connected'",
    'lastErrorReason: null',
    'lastFailedSyncAt: null',
  ]) {
    assert(
      remapHelper.includes(healthDefault),
      `both seed paths must reset local email health via ${healthDefault}`
    );
  }
});

test('integration seed discovers account columns before selecting them', async () => {
  const source = readSeedLocalSource();
  const stableStart = source.indexOf('const PROD_INTEGRATION_COLUMNS = {');
  const stableEnd = source.indexOf('} as const;', stableStart);
  const stableProjection = source.slice(stableStart, stableEnd);
  const helperStart = source.indexOf('async function findProdIntegrations(');
  const helperEnd = source.indexOf('// Keep production reads', helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert(stableStart > 0 && stableEnd > stableStart, 'expected the stable Integration projection');
  assert(
    !stableProjection.includes('accountId: true') &&
      !stableProjection.includes('accountEmail: true'),
    'the pre-migration Integration projection must not request account columns'
  );
  assert(
    source.includes("column_name IN ('accountId', 'accountEmail')"),
    'expected a schema capability probe for the new account columns'
  );
  assert(
    helper.includes('select: PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT') &&
      helper.includes('select: PROD_INTEGRATION_COLUMNS'),
    'expected post-migration and pre-migration Integration read paths'
  );
  assert(
    helper.includes("accountId: '', accountEmail: null"),
    'expected legacy Integration rows to receive the local migration defaults'
  );
});

test('subscription seed discovers stripeLivemode before selecting it', async () => {
  const source = readSeedLocalSource();
  const stableStart = source.indexOf('const PROD_SUBSCRIPTION_COLUMNS = {');
  const stableEnd = source.indexOf('} as const;', stableStart);
  const stableProjection = source.slice(stableStart, stableEnd);
  const helperStart = source.indexOf('async function findProdSubscription(');
  const helperEnd = source.indexOf('\n}\n', helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert(stableStart > 0 && stableEnd > stableStart, 'expected the stable Subscription projection');
  assert(
    !stableProjection.includes('stripeLivemode: true'),
    'the pre-migration Subscription projection must not request stripeLivemode'
  );
  assert(
    source.includes("column_name = 'stripeLivemode'"),
    'expected a schema capability probe for Subscription.stripeLivemode'
  );
  assert(
    helper.includes('select: PROD_SUBSCRIPTION_COLUMNS_WITH_LIVEMODE') &&
      helper.includes('select: PROD_SUBSCRIPTION_COLUMNS'),
    'expected post-migration and pre-migration Subscription read paths'
  );
  assert(
    helper.includes('stripeLivemode: false'),
    'expected legacy Subscription rows to receive the local migration default'
  );
  assert(
    source.includes('findProdSubscription(SEED_USER_ID)'),
    'Subscription sync must use the capability-aware reader'
  );
});

test('integration capability probe retries after a transient rejection and caches success', async () => {
  let attempts = 0;
  const probe = createRetryableProbe(async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient schema probe failure');
    return true;
  });

  let firstRejected = false;
  try {
    await probe();
  } catch (error) {
    firstRejected = error instanceof Error && error.message === 'transient schema probe failure';
  }
  assert(firstRejected, 'expected the first transient schema probe failure to reach the caller');
  assert(await probe(), 'expected the schema probe to retry successfully');
  assert(await probe(), 'expected the successful schema probe result to stay cached');
  assert(attempts === 2, `expected one retry and then a cached success, got ${attempts} attempts`);
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

test('missing-Claude bypass accepts either caller-validated Anthropic-compatible fallback', async () => {
  const source = readSeedLocalSource();
  const zeroClaude = source.indexOf('if (usableClaudeCodeCount === 0)');
  const rateLimitedBypass = source.indexOf('rateLimitedClaudeCodeCount > 0', zeroClaude);
  const bypass = source.indexOf("process.env.SEED_ALLOW_MISSING_CLAUDE_CODE === '1'", zeroClaude);
  const anthropicValidation = source.indexOf('process.env.ANTHROPIC_API_KEY?.trim()', bypass);
  const openrouterValidation = source.indexOf('process.env.OPENROUTER_API_KEY?.trim()', bypass);
  const missingFallbackFailure = source.indexOf(
    'SEED_ALLOW_MISSING_CLAUDE_CODE=1 requires a non-empty ANTHROPIC_API_KEY or OPENROUTER_API_KEY',
    openrouterValidation
  );
  const warning = source.indexOf('caller-validated', bypass);
  const fallback = source.indexOf('Anthropic-compatible API fallback', warning);
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
  assert(anthropicValidation > bypass, 'expected validation of the Anthropic API key');
  assert(openrouterValidation > anthropicValidation, 'expected validation of the OpenRouter key');
  assert(
    missingFallbackFailure > openrouterValidation,
    'expected both missing Anthropic-compatible fallbacks to fail closed'
  );
  assert(warning > missingFallbackFailure, 'expected validation before the fallback warning');
  assert(fallback > warning, 'expected the runtime replacement to be Anthropic-compatible');
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

// any-mode / synthetic pool / AgentCard launcher invariants → seed-local.part3.blackbox.ts

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
