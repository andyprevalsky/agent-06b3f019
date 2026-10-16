import {
  createAnonSession,
  seedClaudeIntegration,
  prisma,
  crypto,
  seedClaudeCodeSession,
  request,
  BASE_URL,
  apiKeyHeaders,
  assertStatus,
  assert,
  cleanupSessions,
  cleanupIntegrations,
  snapshotAnthropicApiKeyCooldown,
  ANTHROPIC_COOLDOWN_USER_ID,
  ANTHROPIC_COOLDOWN_NAME,
  restoreAnthropicApiKeyCooldown,
  waitForServerFundedKeyCooldown,
  API_KEY,
  cooldownIsLive,
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
  ctx,
  uploadFileToIntegrations,
} from './integrations.context';

export async function testClaudeCodeExhaustion_marksPoolToken() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const banner = "You've hit your limit · resets 4:00am (UTC)\nbye\n";
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    const until = row?.rateLimitedUntil;
    assert(until instanceof Date, 'pool integration must be rate-limited after exhaustion banner');
    const utcHour = until!.getUTCHours();
    const utcMinute = until!.getUTCMinutes();
    assert(
      utcHour === 4 && utcMinute === 0,
      `expected next 04:00 UTC, got ${utcHour}:${String(utcMinute).padStart(2, '0')} UTC`
    );
    assert(
      until!.getTime() > Date.now(),
      'rateLimitedUntil must be in the future (rolls forward to next 04:00 UTC if past)'
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

export async function testClaudeCodeExhaustion_marksUserToken() {
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'user', null);
  await prisma.integration.update({
    where: { id: userInt.id },
    data: {
      status: 'EXPIRED',
      isActive: false,
      failureReason: 'auth_error',
    },
  });

  try {
    const banner = "You've hit your limit · resets 9:30pm (UTC)\n";
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    const until = row?.rateLimitedUntil;
    assert(until instanceof Date, 'user integration must be rate-limited after exhaustion banner');
    assert(until!.getUTCHours() === 21, `expected 21:00 UTC, got ${until!.getUTCHours()}:00`);
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([userInt.id]);
  }
}

export async function testClaudeCodeAuthFailure_marksPoolTokenLongCooldown() {
  // Anchors: "Please run /login" / "Not logged in" — emitted by Claude Code CLI
  // when the cached OAuth envelope is broken. This is structurally different
  // from the rate-limit banner: the underlying refreshToken is bad/revoked and
  // won't recover on its own. We mark the pool token broken with a 24h
  // cooldown so the LRU rotates and operators have time to re-sync it.
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const banner = 'Not logged in - Run /login to authenticate. Please run /login\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    const until = row?.rateLimitedUntil;
    assert(
      until instanceof Date,
      'pool integration must be rate-limited after auth-failure banner'
    );
    const msFromNow = until!.getTime() - Date.now();
    // 24h cooldown allows for some clock skew/test latency — accept anything
    // strictly above the 5-minute rate-limit cooldown so we know the longer
    // auth-failure path was taken.
    assert(
      msFromNow > 60 * 60 * 1000,
      `auth-failure cooldown should be > 1h, got ${Math.round(msFromNow / 60000)} min`
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

export async function testClaudeCodeRevokedOauth_disablesUserTokenPermanently() {
  // Exact production banner from deploy smoke d1f8fa0a. The direct-token path
  // had already marked the integration EXPIRED/auth_error, but the Claude Code
  // fallback kept serving its refresh envelope. Once the CLI proves that the
  // refresh grant is also revoked, exclude the envelope permanently.
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-revoked-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'user', null);

  try {
    const banner =
      '[Claude] Session started in /home/user\n' +
      '[Claude] Failed to authenticate. API Error: 401 OAuth access token has been revoked.\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    assert(row?.status === 'EXPIRED', 'revoked user integration must be expired');
    assert(row?.isActive === false, 'revoked user integration must be inactive');
    assert(
      row?.failureReason === 'claude_code_auth_error',
      `revoked refresh envelope must be excluded from the auth_error refresh path, got ${row?.failureReason}`
    );
    assert(
      row.rateLimitedUntil === null,
      'revoked OAuth must not return after a temporary cooldown'
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([userInt.id]);
  }
}

export async function testClaudeCodeBillingFailure_marksPoolTokenLongCooldown() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const banner = 'Credit balance is too low\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    const until = row?.rateLimitedUntil;
    assert(
      until instanceof Date,
      'pool integration must be rate-limited after billing-failure banner'
    );
    const msFromNow = until!.getTime() - Date.now();
    assert(
      msFromNow > 60 * 60 * 1000,
      `billing-failure cooldown should be > 1h, got ${Math.round(msFromNow / 60000)} min`
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

export async function testClaudeCodeBillingFailure_backsOffFundedApiKey() {
  const previousCooldown = await snapshotAnthropicApiKeyCooldown();
  const caller = await createAnonSession();
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-funded-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'anthropic', null);

  try {
    const banner = 'Credit balance is too low\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const cooldown = await prisma.integration.findUnique({
      where: {
        userId_name_accountId: {
          userId: ANTHROPIC_COOLDOWN_USER_ID,
          name: ANTHROPIC_COOLDOWN_NAME,
          accountId: '',
        },
      },
    });
    assert(
      cooldown?.failureReason === 'claude_code_auth_failure',
      `funded API key failure must set the shared cooldown reason, got ${cooldown?.failureReason}`
    );
    assert(
      cooldown.rateLimitedUntil instanceof Date && cooldown.rateLimitedUntil.getTime() > Date.now(),
      'funded API key failure must set a future shared cooldown'
    );
  } finally {
    await restoreAnthropicApiKeyCooldown(previousCooldown);
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await waitForServerFundedKeyCooldown({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      key: 'anthropic',
      onCooldown: cooldownIsLive(previousCooldown),
    });
  }
}

export async function testClaudeCodeBillingFailure_marksSharedAnthropicCooldown() {
  const caller = await createAnonSession();
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-shared-anthropic-cooldown-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'anthropic', null);

  await __resetAnthropicApiKeyCooldown();
  try {
    const banner =
      'Your credit balance is too low to access the Anthropic API. ' +
      'Please go to Plans & Billing to upgrade or purchase credits.\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);
    assert(
      await isAnthropicApiKeyOnCooldown(),
      'shared Anthropic API key must enter cooldown after the captured billing banner'
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await __resetAnthropicApiKeyCooldown();
    await waitForServerFundedKeyCooldown({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      key: 'anthropic',
      onCooldown: false,
    });
  }
}

export async function testClaudeCodeExhaustion_noBannerNoOp() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const benignOutput = 'Computing Collatz sequence... done. Result: 27, 82, 41, ..., 1\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: benignOutput }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    assert(
      row?.rateLimitedUntil === null,
      'integration must NOT be rate-limited when banner is absent'
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

// --- Claude Code token: exercises internal auth paths ---

export async function testClaudeCodeToken_viaApiKeyInternal() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: { ...apiKeyHeaders(ctx.userId1), 'X-Force-Pool': 'true' },
  });
  // Exercises the forcePool=true path; anon user without onboarding → 404
  if (res.status !== 404 && res.status !== 200) {
    throw new Error(`Expected 200 or 404, got ${res.status}`);
  }
}

export async function testClaudeCodeToken_excludePoolTokens() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: {
      ...apiKeyHeaders(ctx.userId1),
      'X-Force-Pool': 'true',
      'X-Exclude-Pool-Tokens': 'token1,token2,token3',
    },
  });
  // Exercises excludePoolTokenIds path
  if (res.status !== 404 && res.status !== 200) {
    throw new Error(`Expected 200 or 404 with exclude tokens, got ${res.status}`);
  }
}

// --- VCF contacts upload: exercises processContactsUpload with valid VCF ---

export async function testContactsUpload_validVcf() {
  const vcfContent = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:John Test',
    'N:Test;John;;;',
    'TEL;TYPE=CELL:+15551234567',
    'EMAIL:john.test@example.com',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Jane Doe',
    'N:Doe;Jane;;;',
    'EMAIL:jane.doe@example.com',
    'END:VCARD',
  ].join('\r\n');

  const res = await uploadFileToIntegrations(
    '/contacts/upload',
    ctx.accessToken1!,
    'contacts.vcf',
    vcfContent,
    'text/vcard'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; parsed: number; created: number; updated: number };
  assert(body.parsed === 2, `Expected 2 parsed contacts, got ${body.parsed}`);
  assert(
    body.message.includes('imported'),
    `Expected import success message, got: ${body.message}`
  );
}
