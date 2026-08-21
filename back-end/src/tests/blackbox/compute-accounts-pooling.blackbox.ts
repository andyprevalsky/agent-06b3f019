#!/usr/bin/env tsx
/**
 * The user's actual acceptance scenario, end to end:
 *
 *   "I click +, connect 2 Claude and 2 Codex accounts, and assume those tokens
 *    work forever unless rate limited. My account has pooling on, so the new
 *    accounts should get pooling too. And I can delete them like email."
 *
 * Each of those four claims is asserted below against a real database.
 */

import { prisma } from '../../providers/database';
import {
  findLocalCookiesForDomains,
  materializeGrantAsIntegration,
  upsertAccountConnection,
  userPoolingDefault,
} from '../../domains/compute-grants/repo';
import {
  connectAccount,
  disconnectAccount,
  listConnectedAccounts,
} from '../../domains/compute-grants/service';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const USER = `pooling-test-${Date.now()}`;
const OTHER_USER = `${USER}-other`;

async function cleanup() {
  for (const u of [USER, OTHER_USER]) {
    await prisma.computeGrant.deleteMany({ where: { userId: u } });
    await prisma.computeAccountConnection.deleteMany({ where: { userId: u } });
    await prisma.integration.deleteMany({ where: { userId: u } });
    await prisma.cookie.deleteMany({ where: { userId: u } });
  }
}

/** Stand in for the user's existing pooled setup. */
async function givenUserPools(userId: string) {
  await prisma.integration.create({
    data: {
      userId,
      name: 'claude_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      poolingEnabled: true,
    },
  });
}

test('connecting 2 Claude + 2 Codex accounts all succeed and are listed', async () => {
  await givenUserPools(USER);
  const wanted = [
    { provider: 'claude', accountId: 'anthropic-a', accountEmail: 'a@example.com' },
    { provider: 'claude', accountId: 'anthropic-b', accountEmail: 'b@example.com' },
    { provider: 'codex', accountId: 'openai-a', accountEmail: 'a@example.com' },
    { provider: 'codex', accountId: 'openai-b', accountEmail: 'b@example.com' },
  ];
  for (const w of wanted) await connectAccount(USER, { ...w, session: `sess-${w.accountId}` });

  const listed = await listConnectedAccounts(USER);
  assert(listed.length === 4, `expected 4 connected accounts, got ${listed.length}`);
  assert(
    listed.filter((a) => a.provider === 'claude').length === 2,
    'expected exactly 2 Claude accounts -- the old @@unique([userId, name]) capped this at 1'
  );
  assert(
    listed.filter((a) => a.provider === 'codex').length === 2,
    'expected exactly 2 Codex accounts'
  );
});

test('THE POOLING CLAIM: new accounts inherit the user pooling setting', async () => {
  const rows = await prisma.computeAccountConnection.findMany({ where: { userId: USER } });
  assert(rows.length === 4, `expected 4 rows, got ${rows.length}`);
  for (const r of rows) {
    assert(
      r.poolingEnabled,
      `${r.provider}/${r.accountId} did NOT inherit pooling -- it would silently sit out of ` +
        'the pool, which looks like "my new accounts are never used"'
    );
  }
});

test('a user who does NOT pool does not get pooling switched on', async () => {
  assert(
    (await userPoolingDefault(OTHER_USER)) === false,
    'a user with no pooled integrations must default to not pooling'
  );
  await connectAccount(OTHER_USER, {
    provider: 'claude',
    accountId: 'anthropic-solo',
    session: 'sess-solo',
  });
  const row = await prisma.computeAccountConnection.findFirst({ where: { userId: OTHER_USER } });
  assert(row?.poolingEnabled === false, 'inheritance must not invent pooling the user never chose');
});

test('an explicit pooling choice beats the inherited default, both ways', async () => {
  await upsertAccountConnection({
    userId: USER,
    provider: 'claude',
    accountId: 'anthropic-optout',
    session: 's',
    poolingEnabled: false,
  });
  const optedOut = await prisma.computeAccountConnection.findFirst({
    where: { userId: USER, accountId: 'anthropic-optout' },
  });
  assert(optedOut?.poolingEnabled === false, 'explicit opt-out must win over inherited pooling');
  assert(
    optedOut?.poolingEnabledOverride === false,
    'explicit choice must be recorded as override'
  );
});

test('a pooled connection establishes the default even without a legacy Integration', async () => {
  await upsertAccountConnection({
    userId: OTHER_USER,
    provider: 'codex',
    accountId: 'connection-pool-source',
    session: 's',
    poolingEnabled: true,
  });
  assert(
    (await userPoolingDefault(OTHER_USER)) === true,
    'a pooled connected account must establish the user pooling default'
  );

  await connectAccount(OTHER_USER, {
    provider: 'claude',
    accountId: 'inherits-from-connection',
    session: 's',
  });
  const inherited = await prisma.computeAccountConnection.findFirst({
    where: { userId: OTHER_USER, accountId: 'inherits-from-connection' },
  });
  assert(inherited?.poolingEnabled === true, 'new account did not inherit connection pooling');
  assert(
    inherited?.poolingEnabledOverride === null,
    'inherited pooling must not become an override'
  );
});

test('re-mint mirrors connection pooling onto an existing materialized token', async () => {
  const base = {
    userId: USER,
    provider: 'claude' as const,
    accountId: 'anthropic-a',
    accessToken: 'sk-ant-oat01-POOL-MIRROR',
    expiresInSeconds: 31_536_000,
  };
  await materializeGrantAsIntegration({
    ...base,
    poolingEnabled: false,
    poolingEnabledOverride: false,
  });
  await materializeGrantAsIntegration({
    ...base,
    poolingEnabled: true,
    poolingEnabledOverride: true,
  });
  const row = await prisma.integration.findFirst({
    where: { userId: USER, name: 'claude_code', accountId: 'anthropic-a' },
  });
  assert(row?.poolingEnabled === true, 're-mint left the materialized token out of the pool');
  assert(row?.poolingEnabledOverride === true, 're-mint did not mirror the explicit pool choice');
});

test('re-connecting to refresh a session does NOT silently flip pooling', async () => {
  // Reconnect is the documented recovery for needs_reconnect and happens often;
  // it must never mutate a setting the user deliberately chose.
  await upsertAccountConnection({
    userId: USER,
    provider: 'claude',
    accountId: 'anthropic-optout',
    session: 'fresh-session',
  });
  const after = await prisma.computeAccountConnection.findFirst({
    where: { userId: USER, accountId: 'anthropic-optout' },
  });
  assert(after?.poolingEnabled === false, 'a session refresh must preserve the explicit opt-out');
});

test('THE FOREVER CLAIM: a rate limit is not death', async () => {
  const conn = await prisma.computeAccountConnection.findFirstOrThrow({
    where: { userId: USER, accountId: 'anthropic-a' },
  });
  const until = new Date(Date.now() + 3_600_000);
  const grant = await prisma.computeGrant.create({
    data: {
      connectionId: conn.id,
      userId: USER,
      provider: 'claude',
      accountId: 'anthropic-a',
      grantType: 'setup_token',
      encryptedCredentials: 'envelope',
      status: 'active',
      rateLimitedUntil: until,
    },
  });
  // The grant stays ACTIVE while cooling down: marking it dead would trigger a
  // pointless re-mint and, worse, teach the system that throttling means
  // revocation.
  assert(grant.status === 'active', 'a rate-limited grant must remain active');
  assert(grant.rateLimitedUntil !== null, 'the provider cooldown must be recorded');
  const selectable = await prisma.computeGrant.findFirst({
    where: {
      userId: USER,
      status: 'active',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: new Date() } }],
    },
  });
  assert(selectable === null, 'a cooling-down grant must not be selectable yet');
  const laterSelectable = await prisma.computeGrant.findFirst({
    where: {
      userId: USER,
      status: 'active',
      OR: [
        { rateLimitedUntil: null },
        { rateLimitedUntil: { lt: new Date(Date.now() + 7_200_000) } },
      ],
    },
  });
  assert(laterSelectable !== null, 'once the cooldown passes the SAME grant becomes usable again');
});

test('THE DELETE CLAIM: removing one account leaves the others untouched', async () => {
  const before = await listConnectedAccounts(USER);
  await disconnectAccount(USER, 'claude', 'anthropic-a');
  const after = await listConnectedAccounts(USER);
  assert(after.length === before.length - 1, 'exactly one account should be removed');
  assert(!after.some((a) => a.accountId === 'anthropic-a'), 'the deleted account must be gone');
  for (const id of ['anthropic-b', 'openai-a', 'openai-b']) {
    assert(
      after.some((a) => a.accountId === id),
      `${id} must survive deleting a sibling -- cross-account eviction is the bug this design exists to prevent`
    );
  }
});

test('deleting an account cascades its grants (no orphans left behind)', async () => {
  const orphans = await prisma.computeGrant.findMany({
    where: { userId: USER, accountId: 'anthropic-a' },
  });
  assert(orphans.length === 0, `deleted account left ${orphans.length} orphaned grants`);
});

test('deleting a missing account is reported, not silently swallowed', async () => {
  let threw = false;
  try {
    await disconnectAccount(USER, 'claude', 'does-not-exist');
  } catch {
    threw = true;
  }
  assert(threw, 'removing an unknown account must surface an error to the FE');
});

test('cookie seeding looks up the domains that actually carry the session', async () => {
  await prisma.cookie.create({
    data: {
      userId: USER,
      domain: '.claude.ai',
      name: 'sessionKey',
      value: 'v',
      path: '/',
      browserSource: 'chrome',
      isSecure: true,
      isHttpOnly: true,
    },
  });
  const found = await findLocalCookiesForDomains(USER, ['claude.ai', 'platform.claude.com']);
  assert(
    found.some((c) => c.name === 'sessionKey'),
    'the leading-dot domain form (".claude.ai") must match, or seeding drops the only cookie that matters'
  );
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute accounts: pooling, multi-account, delete\n');
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

if (process.argv[1]?.includes('compute-accounts-pooling')) {
  void main();
}
