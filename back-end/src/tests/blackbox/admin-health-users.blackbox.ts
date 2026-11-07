#!/usr/bin/env tsx
/**
 * Black-box tests for the admin user directory + account switching.
 *
 * Covers:
 *   GET  /api/admin-health/users       — searchable account + waitlist directory.
 *   POST /api/admin-health/impersonate — mint a session for another account.
 *
 * Invariants covered:
 *   - auth boundary: no auth -> 401, non-admin JWT -> 403 on both routes
 *   - the directory contains real accounts (not just waitlist signups), so an
 *     admin can switch into someone who never joined the waitlist
 *   - phone-bearing rows flagged isAnonymous still appear (the dev/test account
 *     1f85ff25… is flagged anonymous but is a real person)
 *   - search matches name, email, and phone — including a differently formatted
 *     phone, because the directory joins on the last 10 digits
 *   - search escapes LIKE wildcards so '%' is matched literally, not as "all"
 *   - an account merged with a waitlist row yields ONE row carrying both ids
 *   - bad pagination -> 400, oversized search -> 400
 *   - impersonate: unknown user -> 404, missing userId -> 400
 *   - impersonate happy path returns a session whose JWT sub IS the target, and
 *     that session actually authenticates as the target against a real route
 *
 * Usage:
 *   npx tsx src/tests/blackbox/admin-health-users.blackbox.ts
 */

import { randomInt } from 'node:crypto';

import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { prisma } from '../../providers/database';

// Refuse to seed fixtures into prod when this file is run directly.
import './assertLocalDatabase';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const ANDY_PHONE = '+19729777432';
const NON_ADMIN_USER_ID = 'admin-health-users-non-admin';

const ErrorResponseSchema = z.object({ error: z.string() });
const DirectoryPersonSchema = z.object({
  key: z.string(),
  userId: z.string().nullable(),
  waitlistId: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  joinedAt: z.string(),
  invitedAt: z.string().nullable(),
  hasAccount: z.boolean(),
  hasSubscription: z.boolean(),
  isGated: z.boolean(),
  isAdmin: z.boolean(),
});
const DirectoryResponseSchema = z.object({
  people: z.array(DirectoryPersonSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
  search: z.string(),
});
const ImpersonationResponseSchema = z.object({
  session: z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    expires_in: z.number(),
    expires_at: z.number(),
    token_type: z.string(),
  }),
  user: z.object({
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    isAdmin: z.boolean(),
  }),
});

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function tokenFor(userId: string, phone?: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!secret || !supabaseUrl) {
    throw new Error('SUPABASE_JWT_SECRET and SUPABASE_URL are required for admin-health tests');
  }
  return jwt.sign({ sub: userId, phone }, secret, {
    algorithm: 'HS256',
    issuer: `${supabaseUrl}/auth/v1`,
    expiresIn: '1h',
  });
}

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${tokenFor(ANDY_USER_ID, ANDY_PHONE)}` };
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

/** Unique fake phone so parallel cases never collide on User/Waitlist phone uniqueness. */
function uniquePhone(): string {
  return `+1999${String(randomInt(0, 100_000_000_000)).padStart(11, '0')}`;
}

/**
 * Names must not begin with a reserved fixture word (test/blackbox/benchmark/
 * smoke/coverage): the real-person filter classifies those as our own fixtures
 * and drops them from the waitlist half of the directory, so a "blackbox-*"
 * waitlist row could never merge with its account.
 */
function marker(prefix: string): string {
  return `dircase-${prefix}-${Date.now()}-${randomInt(0, 1_000_000)}`;
}

async function searchDirectory(term: string): Promise<z.infer<typeof DirectoryResponseSchema>> {
  const res = await request(
    `${BASE_URL}/api/admin-health/users?search=${encodeURIComponent(term)}&pageSize=100`,
    { headers: adminHeaders() }
  );
  assertStatus(res.status, 200, res.data);
  return assertSchema(DirectoryResponseSchema, res.data, `GET /admin-health/users?search=${term}`);
}

// ── Auth boundary ──

async function testUsers_noAuth() {
  const res = await request(`${BASE_URL}/api/admin-health/users`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'GET /admin-health/users no-auth');
}

async function testUsers_nonAdminForbidden() {
  const res = await request(`${BASE_URL}/api/admin-health/users`, {
    headers: { Authorization: `Bearer ${tokenFor(NON_ADMIN_USER_ID, '+15555550123')}` },
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'GET /admin-health/users non-admin');
}

async function testImpersonate_noAuth() {
  const res = await request(`${BASE_URL}/api/admin-health/impersonate`, {
    method: 'POST',
    body: JSON.stringify({ userId: ANDY_USER_ID }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'POST /admin-health/impersonate no-auth');
}

async function testImpersonate_nonAdminForbidden() {
  const res = await request(`${BASE_URL}/api/admin-health/impersonate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(NON_ADMIN_USER_ID, '+15555550123')}` },
    body: JSON.stringify({ userId: ANDY_USER_ID }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'POST /admin-health/impersonate non-admin');
}

// ── Directory contents ──

async function testUsers_listsAccountWithNoWaitlistRow() {
  const name = marker('dir-acct');
  const phone = uniquePhone();
  const userId = `${name}-uid`;
  try {
    await prisma.user.create({ data: { userId, name, phone, isAnonymous: false } });
    const body = await searchDirectory(name);
    const row = body.people.find((person) => person.userId === userId);
    if (!row) throw new Error('Account with no waitlist row is missing from the directory');
    if (!row.hasAccount) throw new Error('hasAccount must be true for a real account');
    if (row.waitlistId !== null) throw new Error('waitlistId must be null with no waitlist row');
    if (row.key !== `user:${userId}`) throw new Error(`Unexpected row key ${row.key}`);
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function testUsers_includesPhoneBearingAnonymousAccount() {
  const name = marker('dir-anon');
  const phone = uniquePhone();
  const userId = `${name}-uid`;
  try {
    // isAnonymous=true + a real phone is exactly the shape of the core dev/test
    // account; excluding it would hide an admin from their own directory.
    await prisma.user.create({ data: { userId, name, phone, isAnonymous: true } });
    const body = await searchDirectory(name);
    if (!body.people.some((person) => person.userId === userId)) {
      throw new Error('Phone-bearing anonymous account must appear in the directory');
    }
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function testUsers_excludesPhonelessAnonymousAccount() {
  const name = marker('dir-ghost');
  const userId = `${name}-uid`;
  try {
    await prisma.user.create({ data: { userId, name, isAnonymous: true } });
    const body = await searchDirectory(name);
    if (body.people.some((person) => person.userId === userId)) {
      throw new Error('Phone-less anonymous bootstrap row must not pollute the directory');
    }
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function testUsers_mergesAccountAndWaitlistIntoOneRow() {
  const name = marker('dir-merge');
  const digits = String(randomInt(0, 10_000_000_000)).padStart(10, '0');
  const userId = `${name}-uid`;
  try {
    await prisma.user.create({
      data: { userId, name, phone: `+1999${digits}`, isAnonymous: false },
    });
    // Same number, different formatting — the directory joins on last-10 digits.
    await prisma.waitlist.create({
      data: {
        name,
        phone: `(999) ${digits.slice(0, 3)}-${digits.slice(3)}`,
        variant: 'gated-login',
      },
    });
    const body = await searchDirectory(name);
    const rows = body.people.filter((person) => person.name === name);
    if (rows.length !== 1) {
      throw new Error(`Account + waitlist row must merge into one entry, got ${rows.length}`);
    }
    if (rows[0].userId !== userId) throw new Error('Merged row must carry the account userId');
    if (rows[0].waitlistId === null) throw new Error('Merged row must carry the waitlist id');
  } finally {
    await prisma.waitlist.deleteMany({ where: { name } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

// ── Search ──

async function testUsers_searchMatchesEmailAndReformattedPhone() {
  const name = marker('dir-search');
  const digits = String(randomInt(0, 10_000_000_000)).padStart(10, '0');
  const email = `${name}@waitlist-case.dev`;
  const userId = `${name}-uid`;
  try {
    await prisma.user.create({
      data: { userId, name, email, phone: `+1999${digits}`, isAnonymous: false },
    });

    const byEmail = await searchDirectory(email);
    if (!byEmail.people.some((person) => person.userId === userId)) {
      throw new Error('Search by email must find the account');
    }

    // Stored as +1999XXXXXXXXXX; searched with punctuation and no country code.
    const byPhone = await searchDirectory(
      `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    );
    if (!byPhone.people.some((person) => person.userId === userId)) {
      throw new Error('Search by differently formatted phone must find the account');
    }

    const byPartialName = await searchDirectory(name.slice(0, name.length - 3));
    if (!byPartialName.people.some((person) => person.userId === userId)) {
      throw new Error('Substring search by name must find the account');
    }
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function testUsers_searchEscapesLikeWildcards() {
  const name = marker('dir-wild');
  const userId = `${name}-uid`;
  try {
    await prisma.user.create({
      data: { userId, name, phone: uniquePhone(), isAnonymous: false },
    });
    // '%' must be a literal, not "match everything" — otherwise every search
    // containing a percent sign silently returns the whole directory.
    const body = await searchDirectory('%');
    if (body.people.some((person) => person.userId === userId)) {
      throw new Error("Search for '%' matched a row without a literal percent sign");
    }
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function testUsers_paginationAndSearchValidation() {
  const badPage = await request(`${BASE_URL}/api/admin-health/users?page=0`, {
    headers: adminHeaders(),
  });
  assertStatus(badPage.status, 400, badPage.data);

  const badPageSize = await request(`${BASE_URL}/api/admin-health/users?pageSize=101`, {
    headers: adminHeaders(),
  });
  assertStatus(badPageSize.status, 400, badPageSize.data);

  const longSearch = await request(`${BASE_URL}/api/admin-health/users?search=${'a'.repeat(201)}`, {
    headers: adminHeaders(),
  });
  assertStatus(longSearch.status, 400, longSearch.data);
}

// ── Account switching ──

async function testImpersonate_unknownUser404() {
  const res = await request(`${BASE_URL}/api/admin-health/impersonate`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ userId: `missing-${marker('imp')}` }),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'POST /admin-health/impersonate unknown');
}

async function testImpersonate_missingUserId400() {
  const res = await request(`${BASE_URL}/api/admin-health/impersonate`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'POST /admin-health/impersonate missing userId');
}

async function testImpersonate_mintsWorkingTargetSession() {
  const name = marker('imp-target');
  const phone = uniquePhone();
  const userId = `${name}-uid`;
  try {
    await prisma.user.create({ data: { userId, name, phone, isAnonymous: false } });

    const res = await request(`${BASE_URL}/api/admin-health/impersonate`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ userId }),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(
      ImpersonationResponseSchema,
      res.data,
      'POST /admin-health/impersonate'
    );

    if (body.user.userId !== userId) throw new Error('Response identity is not the target');
    if (body.user.isAdmin) throw new Error('A non-admin target must not be reported as admin');

    const claims = jwt.decode(body.session.access_token) as Record<string, unknown> | null;
    if (claims?.sub !== userId) {
      throw new Error(`Minted token sub must be the target, got ${String(claims?.sub)}`);
    }
    if (claims?.phone !== phone) {
      throw new Error(`Minted token must carry the target phone, got ${String(claims?.phone)}`);
    }

    // The token must actually authenticate downstream as the target — and, since
    // the target is not an admin, it must NOT be able to read the admin surface.
    const asTarget = await request(`${BASE_URL}/api/admin-health/users`, {
      headers: { Authorization: `Bearer ${body.session.access_token}` },
    });
    assertStatus(asTarget.status, 403, asTarget.data);

    const settings = await request(`${BASE_URL}/api/user-settings`, {
      headers: { Authorization: `Bearer ${body.session.access_token}` },
    });
    if (settings.status !== 200) {
      throw new Error(
        `Minted session must authenticate as the target on a normal route, got ${settings.status}`
      );
    }
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
}

// The admin-target case switches into Andy's real account. A long-lived workspace database
// keeps that row from earlier runs, but a fresh one (an ephemeral CI VM) has none until some
// other domain creates it, so this suite owns the row it needs. An existing row is untouched.
async function ensureAdminTargetAccount() {
  await prisma.user.upsert({
    where: { userId: ANDY_USER_ID },
    // No phone: User.phone is unique and other suites own the shared test number.
    create: { userId: ANDY_USER_ID, name: 'Andy Prevalsky', isAnonymous: false },
    update: {},
  });
}

async function testImpersonate_adminTargetReportsAdmin() {
  await ensureAdminTargetAccount();
  const res = await request(`${BASE_URL}/api/admin-health/impersonate`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ userId: ANDY_USER_ID }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(
    ImpersonationResponseSchema,
    res.data,
    'POST /admin-health/impersonate admin target'
  );
  if (!body.user.isAdmin) {
    throw new Error('Switching back into an admin account must report isAdmin so the UI restores');
  }
}

// ── Runner ──

async function runPool(
  tests: Array<{ name: string; fn: () => Promise<void> }>,
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(tests.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tests.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= tests.length) return;
      const test = tests[index];
      const start = Date.now();
      try {
        await test.fn();
        results[index] = { name: test.name, passed: true, duration: Date.now() - start };
      } catch (error) {
        results[index] = {
          name: test.name,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - start,
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const tests = [
    { name: 'GET /api/admin-health/users no auth -> 401', fn: testUsers_noAuth },
    { name: 'GET /api/admin-health/users non-admin -> 403', fn: testUsers_nonAdminForbidden },
    { name: 'POST /api/admin-health/impersonate no auth -> 401', fn: testImpersonate_noAuth },
    {
      name: 'POST /api/admin-health/impersonate non-admin -> 403',
      fn: testImpersonate_nonAdminForbidden,
    },
    {
      name: 'GET /api/admin-health/users lists an account with no waitlist row',
      fn: testUsers_listsAccountWithNoWaitlistRow,
    },
    {
      name: 'GET /api/admin-health/users includes phone-bearing anonymous accounts',
      fn: testUsers_includesPhoneBearingAnonymousAccount,
    },
    {
      name: 'GET /api/admin-health/users excludes phone-less anonymous rows',
      fn: testUsers_excludesPhonelessAnonymousAccount,
    },
    {
      name: 'GET /api/admin-health/users merges account + waitlist into one row',
      fn: testUsers_mergesAccountAndWaitlistIntoOneRow,
    },
    {
      name: 'GET /api/admin-health/users searches name, email, and reformatted phone',
      fn: testUsers_searchMatchesEmailAndReformattedPhone,
    },
    {
      name: 'GET /api/admin-health/users escapes LIKE wildcards in search',
      fn: testUsers_searchEscapesLikeWildcards,
    },
    {
      name: 'GET /api/admin-health/users validates pagination + search length',
      fn: testUsers_paginationAndSearchValidation,
    },
    {
      name: 'POST /api/admin-health/impersonate unknown user -> 404',
      fn: testImpersonate_unknownUser404,
    },
    {
      name: 'POST /api/admin-health/impersonate missing userId -> 400',
      fn: testImpersonate_missingUserId400,
    },
    {
      name: 'POST /api/admin-health/impersonate mints a working target session',
      fn: testImpersonate_mintsWorkingTargetSession,
    },
    {
      name: 'POST /api/admin-health/impersonate reports admin targets as admin',
      fn: testImpersonate_adminTargetReportsAdmin,
    },
  ];

  const results = await runPool(tests, CASE_CONCURRENCY);
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.name} (${result.duration}ms)`);
    if (result.error) console.log(`   ${result.error}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} admin-health-users tests passed`
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
