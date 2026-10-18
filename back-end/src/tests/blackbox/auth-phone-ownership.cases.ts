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
 *   - The unique User.phone index: blank anonymous phones are stored as NULL
 *     (so any number of anonymous accounts coexist), stored phones are the
 *     canonical '+digits' form, the database refuses a second row with the same
 *     phone, and concurrent first requests for one new phone create exactly one
 *     account while the losers get 401 `phone_account_exists`.
 *
 * Registered by auth.blackbox.ts (parallel pool). Rows are seeded and removed
 * directly through Prisma, so this file refuses non-local databases.
 */

import './assertLocalDatabase';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../providers/database';
import { isUniqueViolation } from '../../providers/phoneAccountLookup';

export interface PhoneOwnershipDeps {
  baseUrl: string;
  seedOtp: string;
  request: (url: string, options?: RequestInit) => Promise<{ status: number; data: unknown }>;
  uniqueFakePhone: () => string;
  canSeedAuthFlow: () => boolean;
  seedTwilioVerifyCheck: (phone: string, code: string, approved: boolean) => Promise<boolean>;
  seedSupabaseAdminCreate: (phone: string, options: { userId: string }) => Promise<boolean>;
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

/** An existing account's token never copies a phone owned by another account. */
async function testJwtExistingUserDoesNotTakeOwnedPhone(deps: PhoneOwnershipDeps): Promise<void> {
  const ownedPhone = deps.uniqueFakePhone();
  const ownPhone = deps.uniqueFakePhone();
  const ownerId = randomUUID();
  const otherId = randomUUID();
  await prisma.user.create({ data: { userId: ownerId, phone: ownedPhone, isAnonymous: false } });
  await prisma.user.create({ data: { userId: otherId, phone: ownPhone, isAnonymous: false } });
  try {
    const res = await listAgentsAs(deps, supabaseToken({ sub: otherId, phone: ownedPhone }));
    assert(res.status === 200, `Existing user should stay signed in, got ${res.status}`);
    const row = await prisma.user.findUnique({ where: { userId: otherId } });
    assert(row?.phone === ownPhone, `Phone must not move onto a second account: ${row?.phone}`);
  } finally {
    await cleanupUsers([ownerId, otherId]);
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

/** Anonymous tokens carry `phone: ''`; that must be stored as NULL, never ''. */
async function testAnonymousBlankPhonesStoreNullAndCoexist(
  deps: PhoneOwnershipDeps
): Promise<void> {
  const userIds = [randomUUID(), randomUUID()];
  try {
    for (const userId of userIds) {
      // Same claims as sessionTokens.generateAnonymousSession / Supabase anonymous sign-in.
      const token = supabaseToken({ sub: userId, phone: '', is_anonymous: true });
      const res = await listAgentsAs(deps, token);
      assert(res.status === 200, `Anonymous ${userId}: expected 200, got ${res.status}`);
    }
    const rows = await prisma.user.findMany({
      where: { userId: { in: userIds } },
      select: { phone: true, isAnonymous: true },
    });
    assert(rows.length === 2, `Both anonymous accounts must exist, found ${rows.length}`);
    for (const row of rows) {
      assert(
        row.isAnonymous && row.phone === null,
        `Blank phone stored as ${JSON.stringify(row.phone)}`
      );
    }
  } finally {
    await cleanupUsers(userIds);
  }
}

/** Supabase phone claims omit '+'; a new account stores the canonical '+digits'. */
async function testNewAccountStoresCanonicalPhone(deps: PhoneOwnershipDeps): Promise<void> {
  const phone = deps.uniqueFakePhone();
  const userId = randomUUID();
  try {
    const res = await listAgentsAs(deps, supabaseToken({ sub: userId, phone: phone.slice(1) }));
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    const row = await prisma.user.findUnique({ where: { userId } });
    assert(row?.phone === phone, `Expected canonical ${phone}, stored ${String(row?.phone)}`);
  } finally {
    await cleanupUsers([userId]);
  }
}

/** The database itself refuses a second account with the same phone. */
async function testDatabaseRejectsDuplicatePhone(deps: PhoneOwnershipDeps): Promise<void> {
  const phone = deps.uniqueFakePhone();
  const firstId = randomUUID();
  const secondId = randomUUID();
  await prisma.user.create({ data: { userId: firstId, phone, isAnonymous: false } });
  try {
    let rejected: unknown = null;
    try {
      await prisma.user.create({ data: { userId: secondId, phone, isAnonymous: false } });
    } catch (error) {
      rejected = error;
    }
    assert(
      isUniqueViolation(rejected),
      `Expected a P2002 unique violation, got ${String(rejected)}`
    );
    const owners = await prisma.user.count({ where: { phone } });
    assert(owners === 1, `Phone must map to exactly one account, found ${owners}`);
  } finally {
    await cleanupUsers([firstId, secondId]);
  }
}

/** Concurrent first requests for one new phone create exactly one account. */
async function testConcurrentNewPhoneCreatesOneAccount(deps: PhoneOwnershipDeps): Promise<void> {
  const phone = deps.uniqueFakePhone();
  const userIds = Array.from({ length: 6 }, () => randomUUID());
  try {
    const responses = await Promise.all(
      userIds.map((sub) => listAgentsAs(deps, supabaseToken({ sub, phone: phone.slice(1) })))
    );
    const statuses = responses.map((res) => res.status);
    const winners = statuses.filter((status) => status === 200).length;
    assert(winners === 1, `Expected exactly one account to be created, statuses ${statuses}`);
    for (const res of responses) {
      if (res.status === 200) continue;
      const body = res.data as { code?: unknown };
      assert(
        res.status === 401 && body.code === PHONE_ACCOUNT_EXISTS,
        `Losers must get 401 ${PHONE_ACCOUNT_EXISTS}, got ${res.status}: ${JSON.stringify(res.data)}`
      );
    }
    const owners = await prisma.user.findMany({
      where: { phone: { in: [phone, phone.slice(1)] } },
      select: { userId: true },
    });
    assert(owners.length === 1, `Phone must map to exactly one account, found ${owners.length}`);
    assert(userIds.includes(owners[0]!.userId), 'The owner must be one of the racing tokens');
  } finally {
    await cleanupUsers(userIds);
  }
}

async function verifyOtp(
  deps: PhoneOwnershipDeps,
  body: Record<string, unknown>
): Promise<{ status: number; userId: string | undefined; data: unknown }> {
  const res = await deps.request(`${deps.baseUrl}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = res.data as { user?: { id?: string } };
  return { status: res.status, userId: data.user?.id, data: res.data };
}

async function phoneRowIds(phone: string): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { phone: { in: [phone, phone.slice(1)] } },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/** verify-otp signup for a new phone creates exactly one canonical account. */
async function testVerifyOtpNewPhoneCreatesOneAccount(deps: PhoneOwnershipDeps): Promise<void> {
  if (!deps.canSeedAuthFlow()) {
    console.log('    [skipped] capture/replay unavailable -- cannot seed Twilio/Supabase');
    return;
  }
  const phone = deps.uniqueFakePhone();
  const supabaseId = randomUUID();
  try {
    assert(await deps.seedTwilioVerifyCheck(phone, deps.seedOtp, true), 'seed Twilio failed');
    assert(
      await deps.seedSupabaseAdminCreate(phone, { userId: supabaseId }),
      'seed Supabase failed'
    );
    // Concurrent submits of the same OTP (double tap, two tabs) race on one new phone.
    const results = await Promise.all([
      verifyOtp(deps, { phone, token: deps.seedOtp }),
      verifyOtp(deps, { phone, token: deps.seedOtp }),
    ]);
    for (const result of results) {
      assert(
        result.status === 200,
        `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`
      );
      assert(result.userId === supabaseId, `Expected ${supabaseId}, got ${String(result.userId)}`);
    }
    const ids = await phoneRowIds(phone);
    assert(
      ids.length === 1 && ids[0] === supabaseId,
      `Expected one account, found ${ids.join(',')}`
    );
    const row = await prisma.user.findUnique({ where: { userId: supabaseId } });
    assert(row?.phone === phone, `Expected canonical ${phone}, stored ${String(row?.phone)}`);

    // Signing in again lands on the same account without a new row.
    const again = await verifyOtp(deps, { phone, token: deps.seedOtp });
    assert(
      again.status === 200 && again.userId === supabaseId,
      'Repeat sign-in must reuse the account'
    );
    assert((await phoneRowIds(phone)).length === 1, 'Repeat sign-in must not add a row');
  } finally {
    await cleanupUsers([supabaseId]);
  }
}

/** An anonymous visitor signing in with an existing phone joins that account. */
async function testAnonymousUpgradeJoinsExistingPhoneAccount(
  deps: PhoneOwnershipDeps
): Promise<void> {
  if (!deps.canSeedAuthFlow()) {
    console.log('    [skipped] capture/replay unavailable -- cannot seed Twilio Verify');
    return;
  }
  const phone = deps.uniqueFakePhone();
  const ownerId = randomUUID();
  const anonymousId = randomUUID();
  // The owner holds the legacy bare-digit form; sign-in must still find it.
  await prisma.user.create({
    data: { userId: ownerId, phone: phone.slice(1), isAnonymous: false },
  });
  await prisma.user.create({ data: { userId: anonymousId, isAnonymous: true } });
  try {
    assert(await deps.seedTwilioVerifyCheck(phone, deps.seedOtp, true), 'seed Twilio failed');
    const result = await verifyOtp(deps, {
      phone,
      token: deps.seedOtp,
      anonymousUserId: anonymousId,
    });
    assert(
      result.status === 200,
      `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`
    );
    assert(result.userId === ownerId, `Expected existing ${ownerId}, got ${String(result.userId)}`);
    const ids = await phoneRowIds(phone);
    assert(
      ids.length === 1 && ids[0] === ownerId,
      `Phone must keep one account, found ${ids.join(',')}`
    );
    const anonymous = await prisma.user.findUnique({ where: { userId: anonymousId } });
    assert(
      anonymous !== null && anonymous.phone === null,
      'The anonymous row must never receive the phone'
    );
  } finally {
    await cleanupUsers([ownerId, anonymousId]);
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
      name: 'phone ownership -- existing user token never takes an owned phone',
      fn: () => testJwtExistingUserDoesNotTakeOwnedPhone(deps),
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
    {
      name: 'phone ownership -- anonymous blank phones store NULL and coexist',
      fn: () => testAnonymousBlankPhonesStoreNullAndCoexist(deps),
    },
    {
      name: 'phone ownership -- new account stores the canonical +digits phone',
      fn: () => testNewAccountStoresCanonicalPhone(deps),
    },
    {
      name: 'phone ownership -- database rejects a second account with the same phone',
      fn: () => testDatabaseRejectsDuplicatePhone(deps),
    },
    {
      name: 'phone ownership -- verify-otp new phone (concurrent submits) creates one account',
      fn: () => testVerifyOtpNewPhoneCreatesOneAccount(deps),
    },
    {
      name: 'phone ownership -- anonymous upgrade with an existing phone joins that account',
      fn: () => testAnonymousUpgradeJoinsExistingPhoneAccount(deps),
    },
    {
      name: 'phone ownership -- concurrent first requests for one phone create one account',
      fn: () => testConcurrentNewPhoneCreatesOneAccount(deps),
    },
  ];
}
