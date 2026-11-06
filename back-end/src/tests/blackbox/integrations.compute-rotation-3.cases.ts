import {
  createAnonSession,
  seedClaudeIntegration,
  request,
  BASE_URL,
  apiKeyHeaders,
  assertStatus,
  prisma,
  assert,
  cleanupIntegrations,
  completeOnboarding,
  existingComputePoolIds,
  seedGptIntegration,
  existingPoolIds,
  assertSchema,
  buildCredentialPayload,
  crypto,
  encryptPayload,
  authHeaders,
  buildGptCredentialPayload,
} from './integrations.context';
import { ErrorResponse } from './integrations.schemas';

/**
 * Regression: a generic short cooldown must never SHORTEN a provider-supplied
 * long reset window.
 *
 * Prod 2026-07-28 (agent 49b3cc7a): the compute-token endpoint marked the user's
 * claude_code token rate-limited until 2026-07-30T22:00:00Z (the reset Anthropic
 * actually reported) at 16:54:51, then a second generic call at 16:55:06 — with no
 * `rateLimitedUntil` in the body — overwrote it with the default 5-minute window
 * (17:00:06Z). Five minutes later the still-exhausted token was handed out again.
 * Meanwhile, for every second the token was flagged, `fetchClaudeCodeCredentialsWithMeta`
 * skipped it, the pool was exhausted too, and the Claude Code path fell through to
 * the unfunded shared ANTHROPIC_API_KEY — surfacing as "Your credit balance is too
 * low" and `POST /api/claude-code-session/create -> 500` ("No Claude Code credentials
 * available"), even though a perfectly valid synced OAuth token was sitting in the row.
 */
export async function testRotation_rateLimitWindowIsMonotonic() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const userToken = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolToken = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  const longReset = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const markRateLimited = async (body: Record<string, unknown>) => {
    const res = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify(body),
    });
    assertStatus(res.status, 200, res.data);
  };

  try {
    // 1. Provider reported an explicit long reset.
    await markRateLimited({
      type: 'claude',
      source: 'user',
      userId: caller.userId,
      rateLimitedUntil: longReset.toISOString(),
    });
    const afterLong = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(
      afterLong?.rateLimitedUntil?.getTime() === longReset.getTime(),
      `Expected the provider reset ${longReset.toISOString()}, got ${String(afterLong?.rateLimitedUntil)}`
    );

    // 2. A later generic backoff (no rateLimitedUntil → short default) must NOT shorten it.
    await markRateLimited({ type: 'claude', source: 'user', userId: caller.userId });
    const afterGeneric = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(
      afterGeneric?.rateLimitedUntil?.getTime() === longReset.getTime(),
      `A generic backoff shortened the provider reset window to ${String(afterGeneric?.rateLimitedUntil)} ` +
        `(expected it to stay ${longReset.toISOString()}). An exhausted token would be re-served early, ` +
        `and the Claude Code path would fall through to the unfunded ANTHROPIC_API_KEY.`
    );

    // 3. Same invariant on the pool side.
    await markRateLimited({
      type: 'claude',
      source: 'pool',
      poolTokenId: poolToken.id,
      rateLimitedUntil: longReset.toISOString(),
    });
    await markRateLimited({ type: 'claude', source: 'pool', poolTokenId: poolToken.id });
    const afterPoolGeneric = await prisma.integration.findUnique({ where: { id: poolToken.id } });
    assert(
      afterPoolGeneric?.rateLimitedUntil?.getTime() === longReset.getTime(),
      `A generic backoff shortened the pool token's provider reset window to ${String(afterPoolGeneric?.rateLimitedUntil)}`
    );

    // 4. A genuinely LONGER window must still extend the backoff.
    const longerReset = new Date(longReset.getTime() + 60 * 60 * 1000);
    await markRateLimited({
      type: 'claude',
      source: 'user',
      userId: caller.userId,
      rateLimitedUntil: longerReset.toISOString(),
    });
    const afterExtend = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(
      afterExtend?.rateLimitedUntil?.getTime() === longerReset.getTime(),
      `A longer provider reset must extend the window, got ${String(afterExtend?.rateLimitedUntil)}`
    );
  } finally {
    await cleanupIntegrations([userToken.id, poolToken.id]);
  }
}

export async function testRotation_gptUserAuthErrorDisablesToken() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(poolOwner.userId);
  const existing = await existingComputePoolIds();
  const userToken = await seedGptIntegration(caller.userId, { poolingEnabled: false });
  const poolToken = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'gpt',
        source: 'user',
        userId: caller.userId,
        failureReason: 'auth_error',
        // The report names the leased login; unscoped reports disable none (T7).
        integrationId: userToken.id,
      }),
    });
    assertStatus(mark.status, 200, mark.data);

    const disabled = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(disabled !== null, 'Expected disabled GPT user token row to exist');
    assert(disabled.status === 'EXPIRED', 'auth_error must expire GPT user token');
    assert(disabled.isActive === false, 'auth_error must deactivate GPT user token');
    assert(disabled.rateLimitedUntil === null, 'auth_error disable must not use a cooldown');
    assert(disabled.failureReason === 'auth_error', 'auth_error must be recorded');

    const headers: Record<string, string> = { ...apiKeyHeaders(caller.userId) };
    if (existing.length > 0) headers['X-Exclude-Pool-Tokens'] = existing.join(',');
    const next = await request(`${BASE_URL}/api/integrations/compute-code/credentials/token`, {
      headers,
    });
    assertStatus(next.status, 200, next.data);
    const body = next.data as { type: string; source: string; poolTokenId?: string };
    assert(body.type === 'claude', `Expected fallback pool token to be Claude, got ${body.type}`);
    assert(
      body.source === 'pool',
      `Expected disabled GPT user token to fall back to pool, got ${body.source}`
    );
    assert(
      body.poolTokenId === poolToken.id,
      `Expected pool token ${poolToken.id}, got ${body.poolTokenId}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: [userToken.id, poolToken.id] } } });
  }
}

// Test 3: Auto-expiry — a token whose rateLimitedUntil is in the past is available again.
// Locks in that the filter is `rateLimitedUntil < now`, not a permanent disable flag.
export async function testRotation_autoExpiresAfterCooldown() {
  const existing = await existingPoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  const poolOwner = await createAnonSession();
  const pool = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    // Manually put rateLimitedUntil 1 second in the past — simulates cooldown elapsed.
    await prisma.integration.update({
      where: { id: pool.id },
      data: { rateLimitedUntil: new Date(Date.now() - 1000) },
    });

    const excludes = existing.join(',');
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    if (excludes !== '') headers['X-Exclude-Pool-Tokens'] = excludes;

    const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers,
    });
    assertStatus(res.status, 200, res.data);
    const body = res.data as { source: string; poolTokenId: string };
    assert(body.source === 'pool', `Expected source=pool, got ${body.source}`);
    assert(
      body.poolTokenId === pool.id,
      `Expired rate-limit should auto-heal; expected our pool id, got ${body.poolTokenId}`
    );
  } finally {
    await cleanupIntegrations([pool.id]);
  }
}

// Test 4: All tokens exhausted → 404 NoTokensAvailableError.
// The caller has a user token + one pool exists, both rate-limited → no fallback.
export async function testRotation_allExhausted404() {
  const existing = await existingPoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  const poolOwner = await createAnonSession();

  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    const until = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.integration.update({
      where: { id: userInt.id },
      data: { rateLimitedUntil: until },
    });
    await prisma.integration.update({
      where: { id: poolInt.id },
      data: { rateLimitedUntil: until },
    });

    const excludes = existing.join(',');
    const headers: Record<string, string> = apiKeyHeaders(caller.userId);
    if (excludes !== '') headers['X-Exclude-Pool-Tokens'] = excludes;

    const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers,
    });
    assertStatus(res.status, 404, res.data);
    assertSchema(ErrorResponse, res.data, 'all-exhausted 404');
  } finally {
    await cleanupIntegrations([userInt.id, poolInt.id]);
  }
}

// Test 5: Default cooldown (no rateLimitedUntil in body) is a bounded time window,
// not permanent. Guards against a future regression where someone sets it to far-future.
export async function testRotation_defaultCooldownIsBounded() {
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });

  try {
    const markRes = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ source: 'user', userId: caller.userId }),
    });
    assertStatus(markRes.status, 200, markRes.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    const until = row?.rateLimitedUntil;
    assert(until instanceof Date, 'rateLimitedUntil must be set even when body omits it');
    const ms = until!.getTime() - Date.now();
    assert(ms > 0, `rateLimitedUntil must be in the future (got ${ms}ms from now)`);
    assert(
      ms <= 10 * 60 * 1000,
      `default cooldown must be bounded (≤10min); got ${ms}ms — looks permanent`
    );
  } finally {
    await cleanupIntegrations([userInt.id]);
  }
}

export async function testClaudeCodeUpload_clearsRateLimitCooldown() {
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });

  try {
    await prisma.integration.update({
      where: { id: userInt.id },
      data: {
        rateLimitedUntil: new Date(Date.now() + 60 * 60 * 1000),
        lastUsedAt: new Date(),
        failureReason: 'previous token exhausted',
      },
    });

    const encryptedCredentials = buildCredentialPayload(
      `sk-ant-oat-resynced-${crypto.randomBytes(8).toString('hex')}`
    );
    const encrypted = encryptPayload({ encryptedCredentials });
    const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
      method: 'POST',
      headers: authHeaders(caller.accessToken),
      body: JSON.stringify(encrypted),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    assert(row?.rateLimitedUntil === null, 'upload must clear stale rateLimitedUntil');
    assert(row?.lastUsedAt === null, 'upload must clear stale lastUsedAt');
    assert(row?.failureReason === null, 'upload must clear stale failureReason');
  } finally {
    await cleanupIntegrations([userInt.id]);
  }
}

export async function testGptCodeUpload_clearsExpiredAndRateLimitState() {
  const caller = await createAnonSession();
  const userInt = await seedGptIntegration(caller.userId, { poolingEnabled: false });

  try {
    await prisma.integration.update({
      where: { id: userInt.id },
      data: {
        status: 'EXPIRED',
        isActive: false,
        rateLimitedUntil: new Date(Date.now() + 60 * 60 * 1000),
        lastUsedAt: new Date(),
        failureReason: 'auth_error',
      },
    });

    const encryptedCredentials = buildGptCredentialPayload(
      `gpt-resynced-${crypto.randomBytes(8).toString('hex')}`,
      `acct-resynced-${crypto.randomBytes(6).toString('hex')}`
    );
    const encrypted = encryptPayload({ encryptedCredentials });
    const res = await request(`${BASE_URL}/api/integrations/gpt-code/credentials/upload`, {
      method: 'POST',
      headers: authHeaders(caller.accessToken),
      body: JSON.stringify(encrypted),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    assert(row?.status === 'CONNECTED', 'upload must restore CONNECTED status');
    assert(row?.isActive === true, 'upload must reactivate the integration');
    assert(row?.rateLimitedUntil === null, 'upload must clear stale rateLimitedUntil');
    assert(row?.lastUsedAt === null, 'upload must clear stale lastUsedAt');
    assert(row?.failureReason === null, 'upload must clear stale failureReason');
  } finally {
    await cleanupIntegrations([userInt.id]);
  }
}
