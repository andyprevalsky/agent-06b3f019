/**
 * One phone number maps to one account.
 *
 * Covers the two halves of phone login through the real HTTP stack:
 *   - hybridAuth JWT sync: a valid token for an unknown `sub` whose phone is
 *     already owned by another account is refused with 401
 *     `phone_account_exists` and creates no User row. A fresh phone and an
 *     anonymous (phoneless) token still create their account.
 *   - POST /api/auth/verify-otp: a phone matching several rows resolves to the
 *     oldest account, whichever form (+digits / digits) it was stored in.
 *
 * Registered by auth.blackbox.ts (parallel pool). Rows are seeded and removed
 * directly through Prisma, so this file refuses non-local databases.
 */

import './assertLocalDatabase';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../providers/database';

export interface PhoneOwnershipDeps {
  baseUrl: string;
  seedOtp: string;
  request: (url: string, options?: RequestInit) => Promise<{ status: number; data: unknown }>;
  uniqueFakePhone: () => string;
  canSeedAuthFlow: () => boolean;
  seedTwilioVerifyCheck: (phone: string, code: string, approved: boolean) => Promise<boolean>;
}

const PHONE_ACCOUNT_EXISTS = 'phone_account_exists';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function supabaseToken(claims: { sub: string; phone?: string; is_anonymous?: boolean }): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (secret === undefined || secret === '' || supabaseUrl === undefined || supabaseUrl === '') {
    throw new Error('SUPABASE_JWT_SECRET and SUPABASE_URL are required for phone-ownership tests');
  }
  return jwt.sign({ ...claims, aud: 'authenticated', role: 'authenticated' }, secret, {
    algorithm: 'HS256',
    issuer: `${supabaseUrl}/auth/v1`,
    expiresIn: '10m',
  });
}

async function listAgentsAs(deps: PhoneOwnershipDeps, token: string) {
  return deps.request(`${deps.baseUrl}/api/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function cleanupUsers(userIds: string[]): Promise<void> {
  await prisma.credit.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
}

/** A token for an unseen sub must not open a second account on an owned phone. */
async function testJwtUnknownSubWithOwnedPhoneIsRejected(deps: PhoneOwnershipDeps): Promise<void> {
  const phone = deps.uniqueFakePhone();
  const ownerId = randomUUID();
  const intruderId = randomUUID();
  await prisma.user.create({ data: { userId: ownerId, phone, isAnonymous: false } });
  try {
    // Supabase phone claims omit the leading '+'; the owner stored '+digits'.
    const res = await listAgentsAs(deps, supabaseToken({ sub: intruderId, phone: phone.slice(1) }));
    assert(res.status === 401, `Expected 401, got ${res.status}: ${JSON.stringify(res.data)}`);
    const body = res.data as { error?: unknown; code?: unknown };
    assert(body.code === PHONE_ACCOUNT_EXISTS, `Expected code ${PHONE_ACCOUNT_EXISTS}`);
    assert(
      typeof body.error === 'string' &&
        body.error.startsWith('Unauthorized') &&
        /sign in again/i.test(body.error),
      `Expected a sign-in-again message, got ${JSON.stringify(body.error)}`
    );

    const intruderRow = await prisma.user.findUnique({ where: { userId: intruderId } });
    assert(intruderRow === null, 'Rejected token must not create a User row');
    const owners = await prisma.user.count({ where: { phone: { in: [phone, phone.slice(1)] } } });
    assert(owners === 1, `Phone must still map to exactly one account, found ${owners}`);

    const ownerRes = await listAgentsAs(
      deps,
      supabaseToken({ sub: ownerId, phone: phone.slice(1) })
    );
    assert(ownerRes.status === 200, `Owner token should still work, got ${ownerRes.status}`);
  } finally {
    await cleanupUsers([ownerId, intruderId]);
  }
}

/** A brand-new phone still provisions its account on first authenticated request. */
async function testJwtUnknownSubWithNewPhoneCreatesAccount(
  deps: PhoneOwnershipDeps
): Promise<void> {
  const phone = deps.uniqueFakePhone();
  const userId = randomUUID();
  try {
    const res = await listAgentsAs(deps, supabaseToken({ sub: userId, phone }));
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    const row = await prisma.user.findUnique({ where: { userId } });
    assert(row !== null && row.phone === phone, 'New phone should create its User row');
  } finally {
    await cleanupUsers([userId]);
  }
}

/** Anonymous (phoneless) tokens keep creating their account unchanged. */
async function testAnonymousJwtStillCreatesAccount(deps: PhoneOwnershipDeps): Promise<void> {
  const userId = randomUUID();
  try {
    const res = await listAgentsAs(deps, supabaseToken({ sub: userId, is_anonymous: true }));
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    const row = await prisma.user.findUnique({ where: { userId } });
    assert(row !== null && row.isAnonymous && row.phone === null, 'Anonymous row expected');
  } finally {
    await cleanupUsers([userId]);
  }
}

/** OTP login for a phone held by several rows always lands on the oldest account. */
async function testVerifyOtpResolvesPhoneToOldestAccount(deps: PhoneOwnershipDeps): Promise<void> {
  if (!deps.canSeedAuthFlow()) {
    console.log('    [skipped] capture/replay unavailable -- cannot seed Twilio Verify');
    return;
  }
  const phone = deps.uniqueFakePhone();
  const oldestId = randomUUID();
  const newerId = randomUUID();
  // Insert the newer duplicate first so insertion order cannot pick the answer,
  // and store the oldest without '+' to exercise both stored forms.
  await prisma.user.create({
    data: { userId: newerId, phone, isAnonymous: false, createdAt: new Date() },
  });
  await prisma.user.create({
    data: {
      userId: oldestId,
      phone: phone.slice(1),
      isAnonymous: false,
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });
  try {
    assert(
      await deps.seedTwilioVerifyCheck(phone, deps.seedOtp, true),
      'Could not seed Twilio VerificationCheck'
    );
    const res = await deps.request(`${deps.baseUrl}/api/auth/verify-otp`, {
      method: 'POST',
      body: JSON.stringify({ phone, token: deps.seedOtp }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    const body = res.data as { user?: { id?: string } };
    assert(
      body.user?.id === oldestId,
      `Expected oldest account ${oldestId}, got ${String(body.user?.id)}`
    );
  } finally {
    await cleanupUsers([oldestId, newerId]);
  }
}

export function phoneOwnershipCases(
  deps: PhoneOwnershipDeps
): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'phone ownership -- JWT for unknown sub with owned phone -> 401, no row',
      fn: () => testJwtUnknownSubWithOwnedPhoneIsRejected(deps),
    },
    {
      name: 'phone ownership -- JWT for unknown sub with new phone creates account',
      fn: () => testJwtUnknownSubWithNewPhoneCreatesAccount(deps),
    },
    {
      name: 'phone ownership -- anonymous JWT still creates account',
      fn: () => testAnonymousJwtStillCreatesAccount(deps),
    },
    {
      name: 'phone ownership -- verify-otp resolves duplicate phone to oldest account',
      fn: () => testVerifyOtpResolvesPhoneToOldestAccount(deps),
    },
  ];
}
