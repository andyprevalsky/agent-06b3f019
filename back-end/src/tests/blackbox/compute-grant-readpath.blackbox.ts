#!/usr/bin/env tsx
/**
 * The read-path claim: a CONNECTED account is actually usable by an agent.
 *
 * This is the gap that made the whole feature inert -- grants were written to
 * `ComputeGrant`, which `fetchComputeTokenForUser` has never read. Rather than
 * teach the reader about new tables, a minted grant is materialised into
 * `Integration` in the byte-identical envelope it already consumes.
 *
 * These tests assert that from the AGENT's side of the boundary: they call the
 * real `fetchComputeTokenForUser`, not the repo that wrote the row.
 */

import { config } from 'dotenv';
config();

import { prisma } from '../../providers/database';
import {
  materializeGrantAsIntegration,
  buildGrantCredentialJson,
  encryptGrantMaterial,
} from '../../domains/compute-grants/repo';
import {
  fetchComputePoolToken,
  fetchComputeTokenForUser,
} from '../../providers/computeCredentials';
import { fetchGptCodeCredentialsWithMeta } from '../../providers/gptCredentials';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const USER = `readpath-${Date.now()}`;
const ACC_A = 'acct-aaaa-1111';
const ACC_B = 'acct-bbbb-2222';

async function cleanup() {
  await prisma.integration.deleteMany({ where: { userId: { startsWith: 'readpath-' } } });
}

test('a materialised grant is visible to fetchComputeTokenForUser', async () => {
  await materializeGrantAsIntegration({
    userId: USER,
    provider: 'claude',
    accountId: ACC_A,
    accountEmail: 'a@example.com',
    accessToken: 'sk-ant-oat01-READPATH-A',
    expiresInSeconds: 31_536_000,
    poolingEnabled: false,
  });
  const token = await fetchComputeTokenForUser(USER, { tokenType: 'claude' });
  assert(token !== null, 'agent path returned NO token for a connected account');
  assert(
    JSON.stringify(token).includes('READPATH-A'),
    'agent path returned a token that is not the one we connected'
  );
});

test('a materialised Codex grant is visible to the main GPT token read path', async () => {
  const userId = `${USER}-codex`;
  await materializeGrantAsIntegration({
    userId,
    provider: 'codex',
    accountId: 'chatgpt-account-1',
    accountEmail: 'codex@example.com',
    accessToken: 'eyJ-CODEX-READPATH',
    expiresInSeconds: 864_000,
    poolingEnabled: false,
  });
  const token = await fetchComputeTokenForUser(userId, { tokenType: 'gpt' });
  assert(token !== null, 'agent GPT path returned NO token for a connected Codex account');
  assert(
    JSON.stringify(token).includes('CODEX-READPATH'),
    'agent GPT path returned a token that is not the connected Codex grant'
  );
});

test('a complete Codex OAuth grant reaches the Codex CLI sandbox path access-token-only', async () => {
  const userId = `${USER}-codex-cli`;
  await materializeGrantAsIntegration({
    userId,
    provider: 'codex',
    accountId: 'chatgpt-account-cli',
    accountEmail: 'codex-cli@example.com',
    idToken: 'id-token-readpath',
    accessToken: 'access-token-readpath',
    refreshToken: 'refresh-token-readpath',
    expiresInSeconds: 3600,
    poolingEnabled: false,
  });
  const credentials = await fetchGptCodeCredentialsWithMeta(userId);
  assert(credentials !== null, 'Codex CLI path rejected a complete OAuth grant');
  // The sandbox gets the access token only: a sandbox refresh would rotate the
  // grant out from under every other holder (integrations.codex-shared-grant).
  assert(
    !credentials.credentials.includes('refresh-token-readpath'),
    'Codex CLI path handed the sandbox the refresh lineage'
  );
  assert(
    credentials.credentials.includes('access-token-readpath'),
    'Codex CLI path dropped the access token'
  );
  assert(credentials.accountId === 'chatgpt-account-cli', 'Codex CLI path lost account identity');
});

test('TWO accounts coexist -- the single-account limit is gone', async () => {
  await materializeGrantAsIntegration({
    userId: USER,
    provider: 'claude',
    accountId: ACC_B,
    accountEmail: 'b@example.com',
    accessToken: 'sk-ant-oat01-READPATH-B',
    expiresInSeconds: 31_536_000,
    poolingEnabled: false,
  });
  const rows = await prisma.integration.findMany({
    where: { userId: USER, name: 'claude_code' },
  });
  assert(rows.length === 2, `expected 2 claude_code rows, got ${rows.length}`);
  const ids = rows.map((r) => r.accountId).sort();
  assert(ids[0] === ACC_A && ids[1] === ACC_B, `unexpected accountIds: ${ids.join(',')}`);
});

test('re-connecting the SAME account updates in place, never duplicates', async () => {
  await materializeGrantAsIntegration({
    userId: USER,
    provider: 'claude',
    accountId: ACC_A,
    accessToken: 'sk-ant-oat01-READPATH-A2',
    expiresInSeconds: 31_536_000,
    poolingEnabled: false,
  });
  const rows = await prisma.integration.findMany({ where: { userId: USER, name: 'claude_code' } });
  assert(rows.length === 2, `re-connect duplicated rows: ${rows.length}`);
});

test('a rate-limited account is skipped but NOT deleted or marked dead', async () => {
  // A 429 means "come back later", never "this credential is finished". The row
  // must survive so it returns to service on its own.
  await prisma.integration.updateMany({
    where: { userId: USER, name: 'claude_code', accountId: ACC_A },
    data: { rateLimitedUntil: new Date(Date.now() + 3_600_000) },
  });
  const still = await prisma.integration.findFirst({
    where: { userId: USER, name: 'claude_code', accountId: ACC_A },
  });
  assert(still !== null, 'rate limiting must not remove the account');
  assert(still.status === 'CONNECTED', 'rate limiting must not change status');

  const token = await fetchComputeTokenForUser(USER, { tokenType: 'claude' });
  assert(token !== null, 'the OTHER account should still serve while one is cooling down');
  assert(
    JSON.stringify(token).includes('READPATH-B'),
    'expected the non-rate-limited account to be selected'
  );
});

test('re-minting clears a stale cooldown so the account returns to service', async () => {
  await materializeGrantAsIntegration({
    userId: USER,
    provider: 'claude',
    accountId: ACC_A,
    accessToken: 'sk-ant-oat01-READPATH-A3',
    expiresInSeconds: 31_536_000,
    poolingEnabled: false,
  });
  const row = await prisma.integration.findFirst({
    where: { userId: USER, name: 'claude_code', accountId: ACC_A },
  });
  assert(row?.rateLimitedUntil === null, 'a fresh mint must clear rateLimitedUntil');
});

test('pooling is carried onto the materialised row', async () => {
  await materializeGrantAsIntegration({
    userId: `${USER}-pool`,
    provider: 'claude',
    accountId: 'pooled-1',
    accessToken: 'sk-ant-oat01-POOLED',
    expiresInSeconds: 31_536_000,
    poolingEnabled: true,
  });
  const row = await prisma.integration.findFirst({
    where: { userId: `${USER}-pool`, name: 'claude_code' },
  });
  assert(row?.poolingEnabled === true, 'poolingEnabled did not carry onto the Integration row');
});

test('a pooled Claude setup-token is selectable without a refresh token', async () => {
  const pooled = await prisma.integration.findFirst({
    where: { userId: `${USER}-pool`, name: 'claude_code', accountId: 'pooled-1' },
  });
  assert(pooled !== null, 'pooled setup-token fixture is missing');
  const otherPoolRows = await prisma.integration.findMany({
    where: { poolingEnabled: true, id: { not: pooled.id } },
    select: { id: true },
  });
  const token = await fetchComputePoolToken(
    otherPoolRows.map((row) => row.id),
    'claude'
  );
  assert(token?.poolTokenId === pooled.id, 'pool reader rejected the Claude setup-token');
  assert(
    token.accessToken === 'sk-ant-oat01-POOLED',
    'pool reader returned the wrong Claude setup-token'
  );
});

/**
 * The 2026-10-20 prod lease: a Mac keychain envelope (refreshable, 8h access
 * token) whose own `expiresAt` was five days in the past was re-uploaded as
 * CONNECTED and served to agents, so every Claude call got Anthropic 401
 * "OAuth access token has expired" before failing over to GPT. The server
 * never refreshes Claude grants (refresh is single-use and would revoke the
 * user's local Claude Code login), so an envelope past its own expiry is
 * provably unusable and must never be leased -- on the user, pool, or
 * lineage path.
 */
async function insertExpiredKeychainEnvelope(userId: string, poolingEnabled: boolean) {
  const json = JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-EXPIRED-${userId}`,
      refreshToken: 'sk-ant-ort01-keychain-refresh',
      expiresAt: Date.now() - 5 * 24 * 3600 * 1000,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
    },
  });
  return prisma.integration.create({
    data: {
      userId,
      name: 'claude_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled,
      accountId: `expired-${userId}`,
      config: { encryptedCredentials: encryptGrantMaterial(json) },
    },
  });
}

test('a Claude envelope past its own expiresAt is never leased to an agent', async () => {
  const userId = `${USER}-expired`;
  const expired = await insertExpiredKeychainEnvelope(userId, false);
  const direct = await fetchComputeTokenForUser(userId, { tokenType: 'claude' });
  assert(
    !JSON.stringify(direct ?? {}).includes('EXPIRED'),
    'user path leased an access token past its own expiresAt'
  );
  const leased = await fetchComputeTokenForUser(userId, {
    tokenType: 'claude',
    lineageKey: `agent:${userId}`,
    agentId: userId,
    rootAgentId: userId,
  });
  assert(
    !JSON.stringify(leased ?? {}).includes('EXPIRED'),
    'lineage lease path leased an access token past its own expiresAt'
  );
  const pooled = await insertExpiredKeychainEnvelope(`${userId}-pool`, true);
  const otherPoolRows = await prisma.integration.findMany({
    where: { poolingEnabled: true, id: { not: pooled.id } },
    select: { id: true },
  });
  const poolToken = await fetchComputePoolToken(
    otherPoolRows.map((row) => row.id),
    'claude'
  );
  assert(poolToken === null, 'pool path leased a refreshable envelope past its own expiresAt');
  const row = await prisma.integration.findUnique({ where: { id: expired.id } });
  assert(row !== null, 'skipping an expired envelope must not delete the account');
  // T7: an expired access token is not a revoked login. Its device's next sync
  // replaces it, so the lease skips it and never disables it (prod 2026-11-03
  // disabled a healthy subscription this way).
  assert(
    row.status === 'CONNECTED' && row.isActive && row.failureReason === null,
    'an expired access token must be skipped, not disabled'
  );

  // Skipping the expired row must not take the user's healthy account with it.
  await materializeGrantAsIntegration({
    userId,
    provider: 'claude',
    accountId: 'healthy-sibling',
    accessToken: 'sk-ant-oat01-HEALTHY-SIBLING',
    expiresInSeconds: 31_536_000,
    poolingEnabled: false,
  });
  await prisma.integration.update({
    where: { id: expired.id },
    data: { status: 'CONNECTED', isActive: true, failureReason: null },
  });
  const sibling = await fetchComputeTokenForUser(userId, { tokenType: 'claude' });
  assert(
    sibling?.accessToken === 'sk-ant-oat01-HEALTHY-SIBLING',
    'the healthy sibling account must be served once the expired row is skipped'
  );
  const healthy = await prisma.integration.findFirst({
    where: { userId, name: 'claude_code', accountId: 'healthy-sibling' },
  });
  assert(healthy?.status === 'CONNECTED', 'skipping an expired row disabled a healthy sibling');
});

test('the credential envelope has the exact shape the reader expects', async () => {
  // The reader does config.encryptedCredentials -> decrypt -> JSON ->
  // claudeAiOauth.accessToken. A shape change here breaks every agent silently.
  const json = JSON.parse(
    buildGrantCredentialJson({
      userId: 'x',
      provider: 'claude',
      accountId: 'y',
      accessToken: 'sk-ant-oat01-SHAPE',
      expiresInSeconds: 31_536_000,
      poolingEnabled: false,
    })
  ) as { claudeAiOauth?: Record<string, unknown> };
  assert(json.claudeAiOauth !== undefined, 'missing claudeAiOauth wrapper');
  assert(
    json.claudeAiOauth.accessToken === 'sk-ant-oat01-SHAPE',
    'accessToken not at expected path'
  );
  // setup-tokens have NO refresh token; the sandbox CLI must never try to
  // exchange one, and expiresAt must be real (not 0) so nothing forces a refresh.
  assert(json.claudeAiOauth.refreshToken === '', 'setup_token must carry an empty refreshToken');
  assert(
    typeof json.claudeAiOauth.expiresAt === 'number' &&
      (json.claudeAiOauth.expiresAt as number) > Date.now(),
    'expiresAt must be a real future timestamp, never 0'
  );
});

test('the Codex credential envelope has the exact shape the compute-token reader expects', async () => {
  const json = JSON.parse(
    buildGrantCredentialJson({
      userId: 'x',
      provider: 'codex',
      accountId: 'chatgpt-account-shape',
      accessToken: 'eyJ-CODEX-SHAPE',
      expiresInSeconds: 864_000,
      poolingEnabled: false,
    })
  ) as {
    auth_mode?: string;
    tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
    last_refresh?: string;
  };
  assert(json.auth_mode === 'chatgpt', 'Codex envelope must retain auth_mode=chatgpt');
  assert(json.tokens?.access_token === 'eyJ-CODEX-SHAPE', 'missing Codex access token');
  assert(json.tokens.refresh_token === '', 'cloud Codex grant must not expose a refresh lineage');
  assert(
    json.tokens.account_id === 'chatgpt-account-shape',
    'Codex account id is not at the reader path'
  );
  assert(typeof json.last_refresh === 'string', 'Codex envelope must retain last_refresh');
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute-grant read path (agent-visible)\n');
  await cleanup();
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
  await cleanup();
  await prisma.$disconnect();
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('compute-grant-readpath')) void main();
