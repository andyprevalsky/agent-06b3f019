#!/usr/bin/env tsx
/**
 * Black-box tests for the invite-codes domain (part 2: sequential state +
 * waitlist gate + boundary capture tests)
 *
 * Covers:
 *   POST /api/invite-codes/use   — redeem workflow, duplication prevention, exhaustion
 *   GET  /api/invite-codes/check — gate lifts after redeeming; gated phone users
 *                                  are recorded on the waitlist
 *   POST /api/agents             — gated users cannot create agents (403)
 *
 * Boundary capture tests: this domain has NO third-party HTTP boundaries — all
 * operations are local (Prisma DB). Boundary tests verify 0 outbound HTTP calls.
 *
 * DB access: waitlist-recording verification reads the Waitlist table directly
 * via Prisma (same pattern as purchases.testkit.ts). Run through
 * scripts/run-blackbox-tests.sh, which exports the local-Postgres DATABASE_URL.
 *
 * Shared infrastructure lives in invite-codes.testkit.ts; parallel endpoint
 * tests live in invite-codes.blackbox.ts.
 *
 * Usage:
 *   bash scripts/run-blackbox-tests.sh invite-codes.part2
 */

import { config } from 'dotenv';
config();

import jwt from 'jsonwebtoken';
import { prisma } from '../../providers/database';
import {
  BASE_URL,
  CheckResponse,
  ErrorResponse,
  MASTER_CODE,
  MyCodeResponse,
  UseCodeResponse,
  assert,
  assertSchema,
  assertStatus,
  authHeaders,
  captureToken,
  checkCaptureAvailable,
  createAnonSession,
  filterInfraCalls,
  readCapturesForToken,
  request,
  runTest,
  type TestResult,
} from './invite-codes.testkit';

// ==================== HELPERS ====================

/**
 * Mint a Supabase-compatible JWT for a synthetic user. Mirrors the pattern in
 * claude-code.blackbox.ts. The optional phone claim matches Supabase's format
 * (digits, no leading '+').
 */
function mintUserJwt(userId: string, phone?: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (secret === undefined || secret === '' || supabaseUrl === undefined || supabaseUrl === '') {
    throw new Error('SUPABASE_JWT_SECRET and SUPABASE_URL are required for gate tests');
  }
  return jwt.sign(
    {
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      iss: `${supabaseUrl}/auth/v1`,
      ...(phone !== undefined ? { phone } : {}),
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

/** Unique fake MX phone in Supabase claim format (digits, no '+'). */
function uniquePhoneDigits(): string {
  const suffix = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return `52${suffix}`;
}

async function deleteUserRows(userId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { userId } });
}

// ==================== SEQUENTIAL STATE TESTS ====================

/**
 * Full workflow: user1 gets code → user2 uses it → verify state changes.
 */
async function testUse_happyPathWorkflow() {
  const [inviter, redeemer] = await Promise.all([createAnonSession(), createAnonSession()]);

  // Step 1: inviter gets their code
  const codeRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeRes.status, 200, codeRes.data);
  const codeBefore = assertSchema(MyCodeResponse, codeRes.data, 'inviter code before');
  assert(codeBefore.uses === 0, `Expected 0 uses before, got ${codeBefore.uses}`);

  // Step 2: redeemer uses the code
  const useRes = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(redeemer.accessToken),
    body: JSON.stringify({ inviteCode: codeBefore.inviteCode }),
  });
  assertStatus(useRes.status, 200, useRes.data);
  const useBody = assertSchema(UseCodeResponse, useRes.data, 'POST /use happy');
  assert(useBody.success === true, 'Expected success: true');

  // Step 3: verify inviter's uses incremented
  const codeAfter = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeAfter.status, 200, codeAfter.data);
  const afterBody = assertSchema(MyCodeResponse, codeAfter.data, 'inviter code after');
  assert(afterBody.uses === 1, `Expected 1 use after, got ${afterBody.uses}`);
  assert(afterBody.usesRemaining === 2, `Expected 2 remaining, got ${afterBody.usesRemaining}`);
}

/**
 * Duplication prevention: user cannot use a code if they already used one.
 */
async function testUse_alreadyUsedCode() {
  const [inviter, redeemer] = await Promise.all([createAnonSession(), createAnonSession()]);

  const codeRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeRes.status, 200, codeRes.data);
  const code = assertSchema(MyCodeResponse, codeRes.data, 'inviter code').inviteCode;

  // Use the master code first
  const firstUse = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(redeemer.accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(firstUse.status, 200, firstUse.data);

  // Try to use a different code — should fail
  const secondUse = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(redeemer.accessToken),
    body: JSON.stringify({ inviteCode: code }),
  });
  assertStatus(secondUse.status, 400, secondUse.data);
  const errBody = assertSchema(ErrorResponse, secondUse.data, 'POST /use already used');
  assert(
    errBody.error.toLowerCase().includes('already'),
    `Expected "already used" error, got: "${errBody.error}"`
  );
}

/**
 * Code exhaustion: after 3 uses, the code returns 400.
 */
async function testUse_codeExhaustedAfter3Uses() {
  const inviter = await createAnonSession();

  const codeRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeRes.status, 200, codeRes.data);
  const code = assertSchema(MyCodeResponse, codeRes.data, 'inviter code').inviteCode;

  // Use the code 3 times with different users
  for (let i = 0; i < 3; i++) {
    const user = await createAnonSession();
    const res = await request(`${BASE_URL}/api/invite-codes/use`, {
      method: 'POST',
      headers: authHeaders(user.accessToken),
      body: JSON.stringify({ inviteCode: code }),
    });
    assertStatus(res.status, 200, res.data);
  }

  // Verify inviter shows 3 uses, 0 remaining
  const afterRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(afterRes.status, 200, afterRes.data);
  const afterBody = assertSchema(MyCodeResponse, afterRes.data, 'inviter after 3 uses');
  assert(afterBody.uses === 3, `Expected 3 uses, got ${afterBody.uses}`);
  assert(afterBody.usesRemaining === 0, `Expected 0 remaining, got ${afterBody.usesRemaining}`);

  // 4th user tries to use the exhausted code → 400
  const user4 = await createAnonSession();
  const exhaustedRes = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(user4.accessToken),
    body: JSON.stringify({ inviteCode: code }),
  });
  assertStatus(exhaustedRes.status, 400, exhaustedRes.data);
  const errBody = assertSchema(ErrorResponse, exhaustedRes.data, 'POST /use exhausted');
  assert(
    errBody.error.toLowerCase().includes('no uses remaining'),
    `Expected "no uses remaining" error, got: "${errBody.error}"`
  );
}

/**
 * Master code can be used by multiple users independently.
 */
async function testUse_masterCodeMultipleUsers() {
  const [u1, u2] = await Promise.all([createAnonSession(), createAnonSession()]);

  const res1 = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(u1.accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(res1.status, 200, res1.data);

  const res2 = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(u2.accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(res2.status, 200, res2.data);
}

// ==================== WAITLIST GATE TESTS ====================

/**
 * Gate lifecycle: fresh user needs invite → redeems master code → gate lifts.
 */
async function testCheck_gateLiftsAfterMasterCode() {
  const { accessToken } = await createAnonSession();

  const before = await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(before.status, 200, before.data);
  const beforeBody = assertSchema(CheckResponse, before.data, 'GET /check before redeem');
  assert(beforeBody.needsInviteCode === true, 'Expected gate ON before redeeming');

  const use = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(use.status, 200, use.data);

  const after = await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(after.status, 200, after.data);
  const afterBody = assertSchema(CheckResponse, after.data, 'GET /check after redeem');
  assert(afterBody.needsInviteCode === false, 'Expected gate OFF after redeeming master code');
}

/**
 * Gated users with a phone claim are recorded on the waitlist (E.164, variant
 * gated-login), and repeat checks don't duplicate the entry.
 */
async function testCheck_phoneUserRecordedOnWaitlist() {
  const userId = crypto.randomUUID();
  const phoneDigits = uniquePhoneDigits();
  const token = mintUserJwt(userId, phoneDigits);
  const e164 = `+${phoneDigits}`;

  try {
    const res = await request(`${BASE_URL}/api/invite-codes/check`, {
      headers: authHeaders(token),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(CheckResponse, res.data, 'GET /check phone user');
    assert(body.needsInviteCode === true, 'Expected fresh phone user to be gated');

    const entry = await prisma.waitlist.findUnique({ where: { phone: e164 } });
    assert(entry !== null, `Expected waitlist entry for ${e164}, found none`);
    assert(entry!.variant === 'gated-login', `Expected variant gated-login, got ${entry!.variant}`);

    // Second check must not fail on the unique phone constraint
    const res2 = await request(`${BASE_URL}/api/invite-codes/check`, {
      headers: authHeaders(token),
    });
    assertStatus(res2.status, 200, res2.data);
    const count = await prisma.waitlist.count({ where: { phone: e164 } });
    assert(count === 1, `Expected exactly 1 waitlist entry, got ${count}`);
  } finally {
    await prisma.waitlist.deleteMany({ where: { phone: e164 } });
    await deleteUserRows(userId);
  }
}

/**
 * Server-side enforcement: a gated user cannot create agents (403); after
 * redeeming an invite code the gate no longer blocks the request.
 */
async function testGate_blocksAgentCreationUntilInvited() {
  const userId = crypto.randomUUID();
  const token = mintUserJwt(userId);
  let createdAgentId: string | null = null;

  try {
    const gated = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ goal: 'invite-gate blackbox probe' }),
    });
    assertStatus(gated.status, 403, gated.data);
    const errBody = assertSchema(ErrorResponse, gated.data, 'gated agent create');
    assert(
      errBody.error.toLowerCase().includes('invite'),
      `Expected invite-gate error, got: "${errBody.error}"`
    );

    const use = await request(`${BASE_URL}/api/invite-codes/use`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ inviteCode: MASTER_CODE }),
    });
    assertStatus(use.status, 200, use.data);

    const allowed = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ goal: 'invite-gate blackbox probe' }),
    });
    assert(
      allowed.status !== 403,
      `Expected gate to lift after redeeming, still got 403: ${JSON.stringify(allowed.data)}`
    );
    if (allowed.status === 201) {
      createdAgentId = (allowed.data as { agent_id?: string }).agent_id ?? null;
    }
  } finally {
    if (createdAgentId !== null) {
      await request(`${BASE_URL}/api/agents/${createdAgentId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
    }
    await deleteUserRows(userId);
  }
}

// ==================== BOUNDARY CAPTURE TESTS ====================
// These run sequentially because they share the capture buffer.
// All invite-codes endpoints are purely local (Prisma DB) — assert 0 outbound calls.

async function testBoundary_myCodeNoOutboundCalls() {
  const { accessToken } = await createAnonSession();
  const token = captureToken('my-code');

  await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: { ...authHeaders(accessToken), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for GET /my-code, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

async function testBoundary_useValidationNoOutbound() {
  const { accessToken } = await createAnonSession();
  const token = captureToken('use-validation');

  await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'X-Capture-Token': token },
    body: JSON.stringify({}),
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for validation failure, got ${filterInfraCalls(calls).length}`
  );
}

async function testBoundary_useNotFoundNoOutbound() {
  const { accessToken } = await createAnonSession();
  const token = captureToken('use-not-found');

  await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'X-Capture-Token': token },
    body: JSON.stringify({ inviteCode: 999999 }),
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for not-found code, got ${filterInfraCalls(calls).length}`
  );
}

async function testBoundary_useMasterCodeNoOutbound() {
  const { accessToken } = await createAnonSession();
  const token = captureToken('use-master-code');

  await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'X-Capture-Token': token },
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for master code use, got ${filterInfraCalls(calls).length}`
  );
}

async function testBoundary_checkNoOutboundCalls() {
  const { accessToken } = await createAnonSession();
  const token = captureToken('check');

  await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: { ...authHeaders(accessToken), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for GET /check, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Invite Codes Black-box Tests (part 2: state + gate + boundary)\n');
  console.log(`Testing against: ${BASE_URL}\n`);

  const captureAvailable = await checkCaptureAvailable();
  console.log(`  Capture available: ${captureAvailable}\n`);

  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [
    {
      name: 'POST /use -- happy path workflow (invite + redeem + verify)',
      fn: testUse_happyPathWorkflow,
    },
    { name: 'POST /use -- already used code -> 400', fn: testUse_alreadyUsedCode },
    {
      name: 'POST /use -- code exhausted after 3 uses -> 400',
      fn: testUse_codeExhaustedAfter3Uses,
    },
    {
      name: 'POST /use -- master code works for multiple users',
      fn: testUse_masterCodeMultipleUsers,
    },
    {
      name: 'GET /check -- gate lifts after redeeming master code',
      fn: testCheck_gateLiftsAfterMasterCode,
    },
    {
      name: 'GET /check -- gated phone user recorded on waitlist (deduped)',
      fn: testCheck_phoneUserRecordedOnWaitlist,
    },
    {
      name: 'POST /api/agents -- gated user blocked (403) until invited',
      fn: testGate_blocksAgentCreationUntilInvited,
    },
  ];

  if (captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary -- GET /my-code makes no outbound calls',
        fn: testBoundary_myCodeNoOutboundCalls,
      },
      {
        name: 'boundary -- POST /use validation makes no outbound calls',
        fn: testBoundary_useValidationNoOutbound,
      },
      {
        name: 'boundary -- POST /use not-found makes no outbound calls',
        fn: testBoundary_useNotFoundNoOutbound,
      },
      {
        name: 'boundary -- POST /use master code makes no outbound calls',
        fn: testBoundary_useMasterCodeNoOutbound,
      },
      {
        name: 'boundary -- GET /check makes no outbound calls',
        fn: testBoundary_checkNoOutboundCalls,
      }
    );
  } else {
    console.log(
      '  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  console.log(`Running ${sequentialTests.length} sequential tests...`);
  const results: TestResult[] = [];
  for (const test of sequentialTests) {
    const result = await runTest(test.name, test.fn);
    results.push(result);
    const icon = result.passed ? '  PASS' : '  FAIL';
    console.log(
      `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log('\nALL INVITE CODES (PART 2) BLACK-BOX TESTS PASSED\n');
  await prisma.$disconnect();
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
