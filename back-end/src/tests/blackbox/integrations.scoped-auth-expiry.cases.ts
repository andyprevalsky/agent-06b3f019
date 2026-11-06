/**
 * S33 (2026-10-30): one leased subscription's auth_error expired every
 * code-agent subscription its user had. The worker reported
 * `{type, source:"user", userId, failureReason:"auth_error"}` with no
 * credential identity, and the backend expired all of the user's rows in one
 * updateMany (prod: "disabled after auth_error", updated:3, integrationId:null).
 *
 *   lease ── integrationId ──► worker ── auth_error + integrationId ──► expire that row only
 *   auth_error without an id ──► never expires a sibling account
 */
import {
  createAnonSession,
  completeOnboarding,
  crypto,
  buildCredentialPayload,
  buildGptCredentialPayload,
  apiKeyHeaders,
  existingComputePoolIds,
  request,
  BASE_URL,
  assertStatus,
  assert,
  prisma,
} from './integrations.context';

type Kind = { type: 'claude' | 'gpt'; name: 'claude_code' | 'gpt_code' };

async function seedAccounts(userId: string, kind: Kind): Promise<string[]> {
  const ids: string[] = [];
  for (const label of ['a', 'b']) {
    const accountId = `s33-${label}-${crypto.randomBytes(4).toString('hex')}`;
    const token =
      kind.type === 'claude'
        ? buildCredentialPayload(`sk-ant-oat-s33-${crypto.randomBytes(8).toString('hex')}`)
        : buildGptCredentialPayload(
            `gpt-access-s33-${crypto.randomBytes(8).toString('hex')}`,
            accountId
          );
    const row = await prisma.integration.create({
      data: {
        userId,
        name: kind.name,
        accountId,
        type: 'TOOL_SETUP',
        status: 'CONNECTED',
        isActive: true,
        poolingEnabled: false,
        config: { encryptedCredentials: token },
      },
    });
    ids.push(row.id);
  }
  return ids;
}

async function markAuthError(kind: Kind, userId: string, integrationId?: string) {
  const res = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      type: kind.type,
      source: 'user',
      userId,
      failureReason: 'auth_error',
      ...(integrationId ? { integrationId } : {}),
    }),
  });
  assertStatus(res.status, 200, res.data);
}

async function statuses(ids: string[]): Promise<Record<string, string>> {
  const rows = await prisma.integration.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

async function assertAuthErrorExpiresOnlyTheServedAccount(kind: Kind): Promise<void> {
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  const ids = await seedAccounts(caller.userId, kind);
  try {
    // An auth_error that names no credential cannot tell the accounts apart.
    await markAuthError(kind, caller.userId);
    const afterUnscoped = await statuses(ids);
    assert(
      ids.every((id) => afterUnscoped[id] === 'CONNECTED'),
      `${kind.name}: an unscoped auth_error must not expire any account: ${JSON.stringify(afterUnscoped)}`
    );

    // The lease names the exact row it served.
    const headers: Record<string, string> = { ...apiKeyHeaders(caller.userId) };
    const pool = await existingComputePoolIds();
    if (pool.length > 0) headers['X-Exclude-Pool-Tokens'] = pool.join(',');
    const lease = await request(
      `${BASE_URL}/api/integrations/compute-code/credentials/token?tokenType=${kind.type}`,
      { headers }
    );
    assertStatus(lease.status, 200, lease.data);
    const served = (lease.data as { source?: string; integrationId?: string }).integrationId;
    assert(
      typeof served === 'string' && ids.includes(served),
      `${kind.name}: lease must name the served integration, got ${JSON.stringify(lease.data)}`
    );

    // Naming the served row expires exactly that row.
    await markAuthError(kind, caller.userId, served);
    const afterScoped = await statuses(ids);
    const sibling = ids.find((id) => id !== served)!;
    assert(afterScoped[served] === 'EXPIRED', `${kind.name}: the failed account must expire`);
    assert(
      afterScoped[sibling] === 'CONNECTED',
      `${kind.name}: a sibling account must stay CONNECTED: ${JSON.stringify(afterScoped)}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: ids } } });
  }
}

export async function testRotation_userAuthErrorNeverExpiresSiblingAccounts() {
  await assertAuthErrorExpiresOnlyTheServedAccount({ type: 'gpt', name: 'gpt_code' });
  await assertAuthErrorExpiresOnlyTheServedAccount({ type: 'claude', name: 'claude_code' });
}
