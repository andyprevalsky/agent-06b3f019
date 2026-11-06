/**
 * T7 (2026-11-04): compute-token writers disabled healthy code-agent logins.
 * In prod every claude_code row and 3 of 4 gpt_code rows of one user ended
 * EXPIRED / isActive=false / failureReason=auth_error, so every code-agent
 * session fell to the paid funded key. The writers:
 *
 *   POST compute-code/token/rate-limited {source:user, failureReason:auth_error}
 *        with no credential identity ──► "disabled after auth_error", updated:3
 *   lease (computeCredentials) ──► an access token past its own expiresAt
 *        retired as EXPIRED/auth_error (an expiry is not a revocation)
 *   chat rotation (markComputeTokenUnavailable) ──► user report without the
 *        leased integration id
 *
 * A report disables only the login it names, and only when the stored login is
 * still the held token and not expired (codeLoginRejection.ts): expired and
 * replaced logins are left to their device's next sync.
 */
import {
  createAnonSession,
  completeOnboarding,
  crypto,
  buildCredentialPayload,
  encryptClaudeEnvelope,
  apiKeyHeaders,
  existingComputePoolIds,
  request,
  BASE_URL,
  assertStatus,
  assert,
  prisma,
} from './integrations.context';
import {
  fetchComputeTokenForUser,
  markComputeTokenUnavailable,
} from '../../providers/computeCredentials';
import { credentialFingerprint } from '../../providers/codeLoginRejection';

type Kind = { type: 'claude' | 'gpt'; name: 'claude_code' | 'gpt_code' };
const KINDS: Kind[] = [
  { type: 'claude', name: 'claude_code' },
  { type: 'gpt', name: 'gpt_code' },
];
const HOUR = 60 * 60 * 1000;

function codexJwt(expMs: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor(expMs / 1000), n: crypto.randomUUID() })}.sig`;
}

/** A login whose stored access token expires at `expiresAt` (epoch ms). */
async function seedLogin(
  userId: string,
  kind: Kind,
  opts: { expiresAt: number; status?: 'CONNECTED' | 'EXPIRED'; failureReason?: string }
): Promise<{ id: string; accessToken: string }> {
  const accountId = `t7-${crypto.randomBytes(4).toString('hex')}`;
  const accessToken =
    kind.type === 'claude'
      ? `sk-ant-oat-t7-${crypto.randomBytes(8).toString('hex')}`
      : codexJwt(opts.expiresAt);
  const encryptedCredentials =
    kind.type === 'claude'
      ? buildCredentialPayload(accessToken, opts.expiresAt)
      : encryptClaudeEnvelope(
          JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: accessToken, account_id: accountId },
          })
        );
  const status = opts.status ?? 'CONNECTED';
  const row = await prisma.integration.create({
    data: {
      userId,
      name: kind.name,
      accountId,
      type: 'TOOL_SETUP',
      status,
      isActive: status === 'CONNECTED',
      poolingEnabled: false,
      failureReason: opts.failureReason ?? null,
      config: { encryptedCredentials },
    },
  });
  return { id: row.id, accessToken };
}

async function reportAuthError(
  kind: Kind,
  userId: string,
  identity: { integrationId?: string; credential?: string } = {}
) {
  const res = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      type: kind.type,
      source: 'user',
      userId,
      failureReason: 'auth_error',
      ...identity,
    }),
  });
  assertStatus(res.status, 200, res.data);
}

async function rows(ids: string[]) {
  const found = await prisma.integration.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, isActive: true, failureReason: true, updatedAt: true },
  });
  return Object.fromEntries(found.map((row) => [row.id, row]));
}

/** Prod shape: one live login beside already-expired siblings, report names nothing. */
export async function testLoginWriters_unscopedAuthErrorDisablesNoLogin() {
  for (const kind of KINDS) {
    const caller = await createAnonSession();
    await completeOnboarding(caller.userId);
    const live = await seedLogin(caller.userId, kind, { expiresAt: Date.now() + HOUR });
    const stale = [
      await seedLogin(caller.userId, kind, {
        expiresAt: Date.now() + HOUR,
        status: 'EXPIRED',
        failureReason: 'replaced_elsewhere',
      }),
      await seedLogin(caller.userId, kind, {
        expiresAt: Date.now() + HOUR,
        status: 'EXPIRED',
        failureReason: 'replaced_elsewhere',
      }),
    ];
    const ids = [live.id, ...stale.map((row) => row.id)];
    try {
      const before = await rows(ids);
      await reportAuthError(kind, caller.userId);
      const after = await rows(ids);
      assert(
        after[live.id].status === 'CONNECTED' && after[live.id].isActive,
        `${kind.name}: a report naming no login must not disable the live one: ${JSON.stringify(after[live.id])}`
      );
      for (const row of stale) {
        assert(
          after[row.id].failureReason === 'replaced_elsewhere' &&
            after[row.id].updatedAt.getTime() === before[row.id].updatedAt.getTime(),
          `${kind.name}: an unscoped report must not rewrite other logins: ${JSON.stringify(after[row.id])}`
        );
      }
    } finally {
      await prisma.integration.deleteMany({ where: { id: { in: ids } } });
    }
  }
}

/** A login reported with its identity but past its own expiry is expired, not revoked. */
export async function testLoginWriters_reportedExpiredOrReplacedLoginIsNotDisabled() {
  for (const kind of KINDS) {
    const caller = await createAnonSession();
    await completeOnboarding(caller.userId);
    const expired = await seedLogin(caller.userId, kind, { expiresAt: Date.now() - HOUR });
    const replaced = await seedLogin(caller.userId, kind, { expiresAt: Date.now() + HOUR });
    const revoked = await seedLogin(caller.userId, kind, { expiresAt: Date.now() + HOUR });
    const ids = [expired.id, replaced.id, revoked.id];
    try {
      await reportAuthError(kind, caller.userId, {
        integrationId: expired.id,
        credential: credentialFingerprint(expired.accessToken),
      });
      await reportAuthError(kind, caller.userId, {
        integrationId: replaced.id,
        credential: credentialFingerprint('the-token-before-the-device-re-synced'),
      });
      await reportAuthError(kind, caller.userId, {
        integrationId: revoked.id,
        credential: credentialFingerprint(revoked.accessToken),
      });
      const after = await rows(ids);
      assert(
        after[expired.id].status === 'CONNECTED' && after[expired.id].isActive,
        `${kind.name}: an expired login must not be disabled: ${JSON.stringify(after[expired.id])}`
      );
      assert(
        after[replaced.id].status === 'CONNECTED' && after[replaced.id].isActive,
        `${kind.name}: a since re-synced login must not be disabled: ${JSON.stringify(after[replaced.id])}`
      );
      assert(
        after[revoked.id].status === 'EXPIRED' && after[revoked.id].failureReason === 'auth_error',
        `${kind.name}: the held, live login is revoked: ${JSON.stringify(after[revoked.id])}`
      );
    } finally {
      await prisma.integration.deleteMany({ where: { id: { in: ids } } });
    }
  }
}

/** Prod 2026-11-03: the lease retired a Claude login whose access token had expired. */
export async function testLoginWriters_leaseSkipsExpiredClaudeLoginWithoutDisabling() {
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  const kind = KINDS[0];
  const expired = await seedLogin(caller.userId, kind, { expiresAt: Date.now() - HOUR });
  try {
    const headers: Record<string, string> = { ...apiKeyHeaders(caller.userId) };
    const pool = await existingComputePoolIds();
    if (pool.length > 0) headers['X-Exclude-Pool-Tokens'] = pool.join(',');
    const lease = await request(
      `${BASE_URL}/api/integrations/compute-code/credentials/token?tokenType=claude`,
      { headers }
    );
    const served = (lease.data as { integrationId?: string } | undefined)?.integrationId;
    assert(served !== expired.id, 'an expired access token must not be served');
    const after = await rows([expired.id]);
    assert(
      after[expired.id].status === 'CONNECTED' &&
        after[expired.id].isActive &&
        after[expired.id].failureReason === null,
      `the lease must skip, not disable, an expired login: ${JSON.stringify(after[expired.id])}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: expired.id } });
  }
}

/** The backend chat rotation reports the exact leased login it held. */
export async function testLoginWriters_chatRotationDisablesOnlyTheLeasedLogin() {
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  const kind = KINDS[0];
  const first = await seedLogin(caller.userId, kind, { expiresAt: Date.now() + HOUR });
  const sibling = await seedLogin(caller.userId, kind, { expiresAt: Date.now() + HOUR });
  const ids = [first.id, sibling.id];
  try {
    const leased = await fetchComputeTokenForUser(caller.userId, {
      tokenType: 'claude',
      excludePoolTokenIds: await existingComputePoolIds(),
    });
    assert(
      leased !== null && leased.source === 'user' && ids.includes(leased.integrationId ?? ''),
      `expected one of the user's logins, got ${JSON.stringify(leased && { ...leased, accessToken: undefined })}`
    );
    await markComputeTokenUnavailable(leased, 'auth_error');
    const after = await rows(ids);
    const other = ids.find((id) => id !== leased.integrationId)!;
    assert(
      after[leased.integrationId!].status === 'EXPIRED',
      `the rejected leased login must be disabled: ${JSON.stringify(after[leased.integrationId!])}`
    );
    assert(
      after[other].status === 'CONNECTED',
      `a sibling login must stay connected: ${JSON.stringify(after[other])}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: ids } } });
  }
}

/** A report naming an id this server does not hold as that kind of login disables nothing. */
export async function testLoginWriters_reportNamingAnotherLoginKindDisablesNothing() {
  const owner = await createAnonSession();
  await completeOnboarding(owner.userId);
  const claudePool = await seedLogin(owner.userId, KINDS[0], { expiresAt: Date.now() + HOUR });
  await prisma.integration.update({ where: { id: claudePool.id }, data: { poolingEnabled: true } });
  try {
    for (const poolTokenId of [claudePool.id, crypto.randomUUID()]) {
      const res = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({
          type: 'gpt',
          source: 'pool',
          poolTokenId,
          failureReason: 'auth_error',
        }),
      });
      assertStatus(res.status, 200, res.data);
    }
    const row = await prisma.integration.findUnique({ where: { id: claudePool.id } });
    assert(
      row?.poolingEnabled === true && row.failureReason === null,
      `a gpt report naming a claude login must not disable it: ${JSON.stringify(row)}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: claudePool.id } });
  }
}
