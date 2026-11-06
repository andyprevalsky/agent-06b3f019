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
  ctx,
  uploadFileToIntegrations,
} from './integrations.context';

// Credential failures are classified from structured CLI signals only
// (code-agent-login-rejection.blackbox.ts); terminal text never marks anything.
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
