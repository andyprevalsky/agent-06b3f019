import {
  existingPoolIds,
  createAnonSession,
  completeOnboarding,
  seedClaudeIntegration,
  request,
  BASE_URL,
  apiKeyHeaders,
  assertStatus,
  assert,
  prisma,
  cleanupIntegrations,
  existingComputePoolIds,
  seedGptIntegration,
  assertSchema,
  crypto,
} from './integrations.context';
import { ErrorResponse } from './integrations.schemas';

// Test 1: Marking user token rate-limited → GET returns a pool token.
// This is the exact regression Andy saw — rate_limit should flip over to pool.
export async function testRotation_userRateLimitedFallsBackToPool() {
  const callerIds = await existingPoolIds();
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  await completeOnboarding(caller.userId);

  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    // Step 1: Happy path — user token returned before rate-limit.
    const before = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers: apiKeyHeaders(caller.userId),
    });
    assertStatus(before.status, 200, before.data);
    assert(
      (before.data as { source: string }).source === 'user',
      `Pre-rate-limit: expected source=user, got ${JSON.stringify(before.data)}`
    );

    // Step 2: Mark user token rate-limited (the fix that was missing).
    const markRes = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        source: 'user',
        userId: caller.userId,
        rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });
    assertStatus(markRes.status, 200, markRes.data);

    // Step 3: rateLimitedUntil is TIME-WINDOWED (future, not null, not permanent).
    const rowAfterMark = await prisma.integration.findUnique({ where: { id: userInt.id } });
    assert(
      rowAfterMark?.rateLimitedUntil instanceof Date,
      'Integration.rateLimitedUntil must be set after mark'
    );
    const untilMs = rowAfterMark!.rateLimitedUntil!.getTime();
    const nowMs = Date.now();
    assert(
      untilMs > nowMs,
      `rateLimitedUntil must be in the future (got ${untilMs - nowMs}ms from now)`
    );
    assert(
      untilMs - nowMs <= 10 * 60 * 1000,
      `rateLimitedUntil must be bounded (≤10min), got ${untilMs - nowMs}ms — looks permanent`
    );

    // Step 4: GET /credentials/token now falls back to pool (exclude any pre-existing pool tokens).
    const after = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers: {
        ...apiKeyHeaders(caller.userId),
        ...(callerIds.length > 0 ? { 'X-Exclude-Pool-Tokens': callerIds.join(',') } : {}),
      },
    });
    assertStatus(after.status, 200, after.data);
    const afterBody = after.data as { source: string; poolTokenId?: string };
    assert(
      afterBody.source === 'pool',
      `Post-rate-limit: expected source=pool, got ${afterBody.source}`
    );
    assert(
      afterBody.poolTokenId === poolInt.id,
      `Expected our seeded pool token, got ${afterBody.poolTokenId}`
    );
  } finally {
    await cleanupIntegrations([userInt.id, poolInt.id]);
  }
}

// Test 2: Pool rotation — marking pool token A rate-limited makes the next forced-pool
// fetch return token B (never A).
export async function testRotation_poolRotatesOnRateLimit() {
  const existing = await existingPoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);

  const poolOwnerA = await createAnonSession();
  const poolOwnerB = await createAnonSession();
  const poolA = await seedClaudeIntegration(poolOwnerA.userId, { poolingEnabled: true });
  const poolB = await seedClaudeIntegration(poolOwnerB.userId, { poolingEnabled: true });

  // Exclude every pool row that isn't ours so the LRU query is deterministic.
  const excludeHeader = existing.join(',');

  try {
    // Step 1: force-pool → get ONE of our two seeded tokens.
    const fetchPool = async (extraExcludes: string[] = []) => {
      const excludes = [...existing, ...extraExcludes].filter((x) => x !== '');
      const headers: Record<string, string> = {
        ...apiKeyHeaders(caller.userId),
        'X-Force-Pool': 'true',
      };
      if (excludes.length > 0) headers['X-Exclude-Pool-Tokens'] = excludes.join(',');
      return request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, { headers });
    };

    const res1 = await fetchPool();
    assertStatus(res1.status, 200, res1.data);
    const firstId = (res1.data as { poolTokenId: string }).poolTokenId;
    assert(
      [poolA.id, poolB.id].includes(firstId),
      `First fetch: expected one of our seeded pool ids, got ${firstId} (existing=${excludeHeader})`
    );

    // Step 2: mark the returned pool token as rate-limited.
    const markRes = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        source: 'pool',
        poolTokenId: firstId,
        rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });
    assertStatus(markRes.status, 200, markRes.data);

    // Step 3: next force-pool fetch must return the OTHER token (rate-limit filter works).
    const expectedSecondId = firstId === poolA.id ? poolB.id : poolA.id;
    await prisma.integration.update({
      where: { id: expectedSecondId },
      data: {
        status: 'CONNECTED',
        poolingEnabled: true,
        rateLimitedUntil: null,
        failureReason: null,
        lastUsedAt: new Date(Date.now() - 120_000),
      },
    });
    const res2 = await fetchPool([firstId]);
    assertStatus(res2.status, 200, res2.data);
    const secondId = (res2.data as { poolTokenId: string }).poolTokenId;
    assert(secondId !== firstId, `Rotation failed: got same token twice (${firstId})`);
    assert(
      secondId === expectedSecondId,
      `Second fetch: expected the other seeded token, got ${secondId}`
    );
  } finally {
    await cleanupIntegrations([poolA.id, poolB.id]);
  }
}

// Test 2b: Heterogeneous compute pool rotation — GPT and Claude tokens share
// one LRU pool. The backend returns a provider type; callers use that type to
// choose the direct GPT or Claude API path.
export async function testComputeRotation_poolRotatesAcrossProviders() {
  const existing = await existingComputePoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);

  const poolOwnerClaude = await createAnonSession();
  const poolOwnerGpt = await createAnonSession();
  const claudePool = await seedClaudeIntegration(poolOwnerClaude.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 60_000),
  });
  const gptPool = await seedGptIntegration(poolOwnerGpt.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 120_000),
  });

  const fetchPool = async () => {
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    if (existing.length > 0) headers['X-Exclude-Pool-Tokens'] = existing.join(',');
    return request(`${BASE_URL}/api/integrations/compute-code/credentials/token`, { headers });
  };

  try {
    const first = await fetchPool();
    assertStatus(first.status, 200, first.data);
    const firstBody = first.data as {
      type: string;
      source: string;
      poolTokenId?: string;
      accountId?: string;
    };
    assert(
      firstBody.type === 'gpt',
      `Expected LRU GPT pool token first, got ${JSON.stringify(firstBody)}`
    );
    assert(firstBody.source === 'pool', `Expected source=pool, got ${firstBody.source}`);
    assert(
      firstBody.poolTokenId === gptPool.id,
      `Expected GPT pool ${gptPool.id}, got ${firstBody.poolTokenId}`
    );
    assert(
      firstBody.accountId === gptPool.accountId,
      `Expected GPT account ID ${gptPool.accountId}, got ${firstBody.accountId}`
    );

    const markGpt = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'gpt',
        source: 'pool',
        poolTokenId: gptPool.id,
        rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });
    assertStatus(markGpt.status, 200, markGpt.data);

    const second = await fetchPool();
    assertStatus(second.status, 200, second.data);
    const secondBody = second.data as { type: string; source: string; poolTokenId?: string };
    assert(
      secondBody.type === 'claude',
      `Expected rotation across providers to Claude, got ${JSON.stringify(secondBody)}`
    );
    assert(
      secondBody.poolTokenId === claudePool.id,
      `Expected Claude pool ${claudePool.id}, got ${secondBody.poolTokenId}`
    );

    const markClaude = await request(
      `${BASE_URL}/api/integrations/compute-code/token/rate-limited`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({
          type: 'claude',
          source: 'pool',
          poolTokenId: claudePool.id,
          rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
      }
    );
    assertStatus(markClaude.status, 200, markClaude.data);

    const exhausted = await fetchPool();
    assertStatus(exhausted.status, 404, exhausted.data);
    assertSchema(ErrorResponse, exhausted.data, 'compute pool exhausted');
  } finally {
    await cleanupIntegrations([claudePool.id, gptPool.id]);
  }
}

export async function testComputeTokenDuplicateProviderConstraint_returns400() {
  const caller = await createAnonSession();
  const response = await request(
    `${BASE_URL}/api/integrations/compute-code/credentials/token?tokenType=gpt&tokenType=claude`,
    { headers: apiKeyHeaders(caller.userId) }
  );
  assertStatus(response.status, 400, response.data);
  assert(
    (response.data as { error?: string }).error === 'tokenType must be provided at most once',
    `Expected duplicate tokenType validation error, got ${JSON.stringify(response.data)}`
  );
}

export async function testComputeTokenLineageSemaphore_capsLiveGptLeases() {
  const existingPoolIds = await existingComputePoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  // Exercise the token-identity semaphore through a caller-owned credential.
  // A pooled fake credential is visible to the live local worker and can be
  // selected by an unrelated queued workflow, which then rate-limits it after
  // provider validation fails. That made this local DB contract race runtime
  // activity even though the capacity behavior itself is source-agnostic.
  const gptCredential = await seedGptIntegration(caller.userId, {
    poolingEnabled: false,
    lastUsedAt: new Date(Date.now() - 120_000),
  });
  const lineageKeys = Array.from(
    { length: 17 },
    (_, idx) => `test-lineage-gpt-${crypto.randomUUID()}-${idx}`
  );

  const fetchToken = async (lineageKey: string) => {
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
    };
    // Capacity exhaustion on the caller credential must not fall through to an
    // unrelated production-synced pool token in this isolated contract.
    if (existingPoolIds.length > 0) {
      headers['X-Exclude-Pool-Tokens'] = existingPoolIds.join(',');
    }
    const params = new URLSearchParams({
      lineageKey,
      agentId: lineageKey,
      rootAgentId: lineageKey,
    });
    return request(`${BASE_URL}/api/integrations/compute-code/credentials/token?${params}`, {
      headers,
    });
  };

  try {
    for (const lineageKey of lineageKeys.slice(0, 16)) {
      const res = await fetchToken(lineageKey);
      assertStatus(res.status, 200, res.data);
      const body = res.data as {
        type: string;
        source: string;
        poolTokenId?: string;
        lineageKey?: string;
      };
      assert(body.type === 'gpt', `Expected GPT token, got ${JSON.stringify(body)}`);
      assert(body.source === 'user', `Expected user token, got ${JSON.stringify(body)}`);
      assert(body.poolTokenId === undefined, `Expected no pool token, got ${body.poolTokenId}`);
      assert(
        body.lineageKey === lineageKey,
        `Expected lineage echo ${lineageKey}, got ${body.lineageKey}`
      );
    }

    const reused = await fetchToken(lineageKeys[0]);
    assertStatus(reused.status, 200, reused.data);

    const exhausted = await fetchToken(lineageKeys[16]);
    assertStatus(exhausted.status, 404, exhausted.data);

    await prisma.computeTokenLineageLease.updateMany({
      where: { lineageKey: { in: lineageKeys.slice(0, 16) } },
      data: { lastUsedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const afterStale = await fetchToken(lineageKeys[16]);
    assertStatus(afterStale.status, 200, afterStale.data);
  } finally {
    await prisma.computeTokenLineageLease.deleteMany({
      where: { lineageKey: { in: lineageKeys } },
    });
    await cleanupIntegrations([gptCredential.id]);
  }
}
