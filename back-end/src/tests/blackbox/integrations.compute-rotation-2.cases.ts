import {
  createAnonSession,
  completeOnboarding,
  crypto,
  seedGptIntegration,
  seedClaudeIntegration,
  apiKeyHeaders,
  existingComputePoolIds,
  request,
  BASE_URL,
  assertStatus,
  assert,
  prisma,
  cleanupIntegrations,
  fetchClaudeCodeCredentialsWithMeta,
} from './integrations.context';

export async function testComputeTokenFastCacheAffinity_pinsProviderFamily() {
  const caller = await createAnonSession();
  const gptOwner = await createAnonSession();
  const claudeOwner = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(gptOwner.userId);
  await completeOnboarding(claudeOwner.userId);

  const affinityKey = `test-affinity-${crypto.randomUUID()}`;
  const lineages = [
    `test-affinity-lineage-${crypto.randomUUID()}-1`,
    `test-affinity-lineage-${crypto.randomUUID()}-2`,
  ];
  const gptPool = await seedGptIntegration(gptOwner.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 120_000),
  });
  const claudePool = await seedClaudeIntegration(claudeOwner.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 60_000),
  });

  const fetchPool = async (lineageKey: string) => {
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    // Other blackbox domains seed pool credentials concurrently. Snapshot at
    // request time so this affinity assertion only considers its own pair.
    const currentPoolIds = await existingComputePoolIds();
    const exclude = currentPoolIds.filter((id) => id !== gptPool.id && id !== claudePool.id);
    if (exclude.length > 0) headers['X-Exclude-Pool-Tokens'] = exclude.join(',');
    const params = new URLSearchParams({
      lineageKey,
      agentId: lineageKey,
      rootAgentId: lineageKey,
      fastCacheAffinityKey: affinityKey,
    });
    return request(`${BASE_URL}/api/integrations/compute-code/credentials/token?${params}`, {
      headers,
    });
  };

  try {
    const first = await fetchPool(lineages[0]);
    assertStatus(first.status, 200, first.data);
    const firstBody = first.data as {
      type: string;
      poolTokenId?: string;
      fastCacheAffinityKey?: string;
    };
    const selectedPool = firstBody.type === 'gpt' ? gptPool : claudePool;
    const unselectedPool = firstBody.type === 'gpt' ? claudePool : gptPool;
    assert(
      firstBody.type === 'gpt' || firstBody.type === 'claude',
      `Expected a supported compute provider, got ${JSON.stringify(firstBody)}`
    );
    assert(
      firstBody.poolTokenId === selectedPool.id,
      `Expected one of the isolated pools, got ${firstBody.poolTokenId}`
    );
    assert(
      firstBody.fastCacheAffinityKey === affinityKey,
      'Expected affinity key echoed in token response'
    );

    await prisma.integration.update({
      where: { id: selectedPool.id },
      data: { lastUsedAt: new Date() },
    });
    await prisma.integration.update({
      where: { id: unselectedPool.id },
      data: { lastUsedAt: new Date(Date.now() - 180_000) },
    });

    const second = await fetchPool(lineages[1]);
    assertStatus(second.status, 200, second.data);
    const secondBody = second.data as {
      type: string;
      poolTokenId?: string;
      fastCacheAffinityKey?: string;
    };
    assert(
      secondBody.type === firstBody.type,
      `Expected pinned affinity to keep ${firstBody.type} despite the other provider being LRU, got ${JSON.stringify(secondBody)}`
    );
    assert(
      secondBody.poolTokenId === selectedPool.id,
      `Expected pinned pool ${selectedPool.id}, got ${secondBody.poolTokenId}`
    );
    assert(
      secondBody.fastCacheAffinityKey === affinityKey,
      'Expected affinity key echoed on pinned response'
    );
  } finally {
    await prisma.computeTokenLineageLease.deleteMany({ where: { lineageKey: { in: lineages } } });
    await prisma.computeTokenFastCacheAffinity.deleteMany({ where: { affinityKey } });
    await cleanupIntegrations([gptPool.id, claudePool.id]);
  }
}

export async function testComputeTokenProviderConstraint_overridesClaudeAffinity() {
  const existingPoolIds = await existingComputePoolIds();
  const caller = await createAnonSession();
  const gptOwner = await createAnonSession();
  const claudeOwner = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(gptOwner.userId);
  await completeOnboarding(claudeOwner.userId);

  const affinityKey = `test-provider-constraint-affinity-${crypto.randomUUID()}`;
  const lineageKey = `test-provider-constraint-lineage-${crypto.randomUUID()}`;
  const gptPool = await seedGptIntegration(gptOwner.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 60_000),
  });
  const claudePool = await seedClaudeIntegration(claudeOwner.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 120_000),
  });

  await prisma.computeTokenFastCacheAffinity.create({
    data: { affinityKey, userId: caller.userId, tokenType: 'claude' },
  });

  try {
    const excluded = existingPoolIds.filter((id) => id !== gptPool.id && id !== claudePool.id);
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    if (excluded.length > 0) headers['X-Exclude-Pool-Tokens'] = excluded.join(',');
    const params = new URLSearchParams({
      lineageKey,
      agentId: lineageKey,
      rootAgentId: lineageKey,
      fastCacheAffinityKey: affinityKey,
      tokenType: 'gpt',
    });
    const response = await request(
      `${BASE_URL}/api/integrations/compute-code/credentials/token?${params}`,
      { headers }
    );
    assertStatus(response.status, 200, response.data);
    const body = response.data as { type: string; poolTokenId?: string; lineageKey?: string };
    assert(body.type === 'gpt', `Expected GPT-only lease, got ${JSON.stringify(body)}`);
    assert(
      body.poolTokenId === gptPool.id,
      `Expected GPT pool ${gptPool.id}, got ${body.poolTokenId}`
    );
    assert(
      body.lineageKey === lineageKey,
      `Expected lineage ${lineageKey}, got ${body.lineageKey}`
    );
  } finally {
    await prisma.computeTokenLineageLease.deleteMany({ where: { lineageKey } });
    await prisma.computeTokenFastCacheAffinity.deleteMany({ where: { affinityKey } });
    await cleanupIntegrations([gptPool.id, claudePool.id]);
  }
}

export async function testRotation_poolAuthErrorDisablesToken() {
  const caller = await createAnonSession();
  const poolOwnerA = await createAnonSession();
  const poolOwnerB = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(poolOwnerA.userId);
  await completeOnboarding(poolOwnerB.userId);
  const existing = await existingComputePoolIds();
  const poolA = await seedClaudeIntegration(poolOwnerA.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 120_000),
  });
  const poolB = await seedClaudeIntegration(poolOwnerB.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 60_000),
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
    const firstBody = first.data as { poolTokenId?: string };
    const firstId = firstBody.poolTokenId;
    assert(
      firstId !== undefined && [poolA.id, poolB.id].includes(firstId),
      `Expected one of our seeded pool tokens, got ${firstId}`
    );

    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'claude',
        source: 'pool',
        poolTokenId: firstId,
        failureReason: 'auth_error',
      }),
    });
    assertStatus(mark.status, 200, mark.data);

    const disabled = await prisma.integration.findUnique({ where: { id: firstId } });
    assert(disabled !== null, 'Expected disabled pool token row to exist');
    assert(disabled.poolingEnabled === false, 'auth_error must disable pool selection');
    assert(disabled.rateLimitedUntil === null, 'auth_error disable must not use a cooldown');
    assert(disabled.failureReason === 'auth_error', 'auth_error must be recorded');

    const second = await fetchPool();
    assertStatus(second.status, 200, second.data);
    const secondBody = second.data as { poolTokenId?: string };
    const expectedSecondId = firstId === poolA.id ? poolB.id : poolA.id;
    assert(
      secondBody.poolTokenId === expectedSecondId,
      `Expected disabled token to be skipped; got ${secondBody.poolTokenId}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: [poolA.id, poolB.id] } } });
  }
}

export async function testRotation_userAuthErrorDisablesToken() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(poolOwner.userId);
  const existing = await existingComputePoolIds();
  const userToken = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolToken = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'claude',
        source: 'user',
        userId: caller.userId,
        failureReason: 'auth_error',
        // The report names the leased login; unscoped reports disable none (T7).
        integrationId: userToken.id,
      }),
    });
    assertStatus(mark.status, 200, mark.data);

    const disabled = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(disabled !== null, 'Expected disabled user token row to exist');
    assert(disabled.status === 'EXPIRED', 'auth_error must expire user token');
    assert(disabled.isActive === false, 'auth_error must deactivate user token');
    assert(disabled.rateLimitedUntil === null, 'auth_error disable must not use a cooldown');
    assert(disabled.failureReason === 'auth_error', 'auth_error must be recorded');

    const headers: Record<string, string> = { ...apiKeyHeaders(caller.userId) };
    if (existing.length > 0) headers['X-Exclude-Pool-Tokens'] = existing.join(',');
    const next = await request(`${BASE_URL}/api/integrations/compute-code/credentials/token`, {
      headers,
    });
    assertStatus(next.status, 200, next.data);
    const body = next.data as { source: string; poolTokenId?: string };
    assert(
      body.source === 'pool',
      `Expected disabled user token to fall back to pool, got ${body.source}`
    );
    assert(
      body.poolTokenId === poolToken.id,
      `Expected pool token ${poolToken.id}, got ${body.poolTokenId}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: [userToken.id, poolToken.id] } } });
  }
}

export async function testRotation_directAuthErrorFallsBackToPoolForClaudeCode() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const userToken = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolToken = await seedClaudeIntegration(poolOwner.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(0),
  });

  try {
    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'claude',
        source: 'user',
        userId: caller.userId,
        failureReason: 'auth_error',
        // The report names the leased login; unscoped reports disable none (T7).
        integrationId: userToken.id,
      }),
    });
    assertStatus(mark.status, 200, mark.data);

    const disabled = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(disabled?.status === 'EXPIRED', 'direct auth_error must disable direct token use');

    // The rejected grant is never handed to a sandbox to refresh: a refresh
    // would revoke the user's own Claude Code holding the same grant.
    const codeCredential = await fetchClaudeCodeCredentialsWithMeta(caller.userId);
    assert(
      codeCredential?.source === 'pool' && codeCredential.poolTokenId === poolToken.id,
      'Claude Code must use the available pool token after the user token failed authentication'
    );
    assert(
      codeCredential.credentialMode === 'oauth_token' && codeCredential.credentials === undefined,
      'Claude Code sandboxes receive only an access token, never a refreshable envelope'
    );
  } finally {
    await cleanupIntegrations([userToken.id, poolToken.id]);
  }
}

export async function testRotation_nearExpiryClaudeCodeTokenIsNotServed() {
  const caller = await createAnonSession();
  const userToken = await seedClaudeIntegration(caller.userId, {
    poolingEnabled: false,
    expiresAt: Date.now() + 30_000,
  });

  try {
    const codeCredential = await fetchClaudeCodeCredentialsWithMeta(caller.userId);
    assert(
      codeCredential?.source !== 'user',
      'A near-expiry user access token must not be served; its device refreshes and re-uploads'
    );
  } finally {
    await cleanupIntegrations([userToken.id]);
  }
}
