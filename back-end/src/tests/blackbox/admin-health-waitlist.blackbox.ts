#!/usr/bin/env tsx
/**
 * Black-box tests for the admin-health waitlist actions.
 *
 * Covers:
 *   GET  /api/admin-health/waitlist            — list phone-bearing signups.
 *   POST /api/admin-health/waitlist/:id/invite — pull a person off the waitlist.
 *
 * Invariants covered:
 *   - auth boundary: no auth -> 401, non-admin JWT -> 403 on both routes
 *   - list shape: people carry name/email/phone/joined/invited/account-status
 *   - not-found: inviting an unknown id -> 404 (before any SMS is sent)
 *   - flag: markOffWaitlistByPhone stamps offWaitlistAt and is idempotent
 *   - status derivation: getWaitlistPeople joins signups to accounts + gate state
 *
 * The invite flags the account off the waitlist (so onboarding shows the
 * subscription view) — it does NOT grant access. Outside production the SMS
 * and email are skipped, so the happy-path test never contacts anyone.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/admin-health-waitlist.blackbox.ts
 */

import { randomInt } from 'node:crypto';

import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { getWaitlistPeople } from '../../domains/admin-health/service.waitlist';
import { findWaitlistPeople, findWaitlistPersonById } from '../../domains/admin-health/repo';
import { checkInviteCode } from '../../domains/invite-codes/service';
import { prisma } from '../../providers/database';
import { isRealWaitlistPerson, realWaitlistPersonSql } from '../../providers/waitlistIdentity';
import { Prisma } from '@prisma/client';
import { markOffWaitlistByPhone } from '../../providers/inviteGate';

// Refuse to seed fixtures into prod when this file is run directly (bypassing
// the runner, which is what put ~2,690 fixture rows in the prod Waitlist table).
import './assertLocalDatabase';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const NON_ADMIN_USER_ID = 'admin-health-waitlist-non-admin';

const ErrorResponseSchema = z.object({ error: z.string() });
const WaitlistPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  variant: z.string().nullable(),
  joinedAt: z.string(),
  invitedAt: z.string().nullable(),
  hasAccount: z.boolean(),
  isGated: z.boolean(),
});
const WaitlistPeopleResponseSchema = z.object({
  people: z.array(WaitlistPersonSchema),
  total: z.number(),
});
const WaitlistInviteResponseSchema = z.object({
  id: z.string(),
  invitedAt: z.string(),
  smsSent: z.boolean(),
  emailSent: z.boolean(),
  flagged: z.boolean(),
  alreadyOffWaitlist: z.boolean(),
  hasAccount: z.boolean(),
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

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
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

// A unique fake phone per seeding test so parallel cases never collide on the
// Waitlist.phone unique constraint or on each other's account rows.
/**
 * A number that reads as a real signup but can never route to a handset: NANP
 * 555-0100..555-0199 is the officially fictional subscriber range.
 *
 * It deliberately avoids the +1555/+1999 prefixes, which are classified as
 * waitlist fixtures and therefore excluded from the real-people surfaces — a
 * row seeded there could not exercise the inclusion path at all.
 */
function uniquePhone(): string {
  const areaCode = randomInt(200, 990);
  return `+1${areaCode}555${String(randomInt(100, 200)).padStart(4, '0')}`;
}

/** An identity the real-people filter must reject, for exclusion assertions. */
function fixtureEmail(marker: string): string {
  return `${marker}@blackbox-test.dev`;
}

async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/admin-health/waitlist`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'GET /admin-health/waitlist no-auth');
}

async function testList_nonAdminForbidden() {
  const res = await request(`${BASE_URL}/api/admin-health/waitlist`, {
    headers: authHeaders(tokenFor(NON_ADMIN_USER_ID, '+15555550123')),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'GET /admin-health/waitlist non-admin');
}

async function testList_adminListsSeededPerson() {
  const marker = `wlcase-wlp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${marker}@waitlist-case.dev`;
  const phone = uniquePhone();
  try {
    await prisma.waitlist.create({
      data: { name: marker, email, phone, variant: 'gated-login' },
    });
    const res = await request(`${BASE_URL}/api/admin-health/waitlist`, {
      headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(WaitlistPeopleResponseSchema, res.data, 'GET /admin-health/waitlist');
    const seeded = body.people.find((person) => person.phone === phone);
    if (!seeded) throw new Error('Seeded waitlist person missing from list');
    if (seeded.name !== marker) throw new Error(`Expected name ${marker}, got ${seeded.name}`);
    const rawPeople = (res.data as { people?: Array<Record<string, unknown>> }).people;
    const rawSeeded = rawPeople?.find((person) => person.phone === phone);
    if (rawSeeded?.email !== email) {
      throw new Error(`Expected email ${email}, got ${String(rawSeeded?.email)}`);
    }
    if (seeded.invitedAt !== null) throw new Error('Fresh signup must not be invited yet');
    if (seeded.hasAccount) throw new Error('No account exists for the seeded phone');
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: marker } });
  }
}

async function testList_excludesWhitespaceOnlyPhones() {
  const marker = `wlcase-wlspace-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const whitespacePhone = `${' '.repeat(20)}\t${' '.repeat(Math.floor(Math.random() * 20) + 1)}`;
  try {
    const seeded = await prisma.waitlist.create({
      data: { name: marker, phone: whitespacePhone, variant: 'gated-login' },
    });
    const page = await findWaitlistPeople({ skip: 0, take: 10_000 });
    if (page.rows.some((row) => row.id === seeded.id)) {
      throw new Error('Whitespace-only phone consumed an actionable waitlist row');
    }
    if (page.total !== page.rows.length) {
      throw new Error(
        `Actionable total ${page.total} does not match the complete row set ${page.rows.length}`
      );
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: marker } });
  }
}

/**
 * The regression this filter was rebuilt around: a signup with an email and no
 * phone is a real person. The list used to require a phone as a stand-in for
 * "not fixture junk", which hid every landing-form signup (that form collects
 * no phone at all) plus a manually imported roster.
 */
async function testList_includesEmailOnlySignup() {
  const marker = `wlcase-emailonly-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${marker}@waitlist-case.dev`;
  try {
    const seeded = await prisma.waitlist.create({
      data: { name: marker, email, phone: null, variant: 'landing-page-a' },
    });
    const page = await findWaitlistPeople({ skip: 0, take: 100_000 });
    const row = page.rows.find((candidate) => candidate.id === seeded.id);
    if (!row) throw new Error('Email-only signup missing from the waitlist list');
    if (row.phone !== null) throw new Error(`Expected a null phone, got ${String(row.phone)}`);
    if (row.email !== email) throw new Error(`Expected email ${email}, got ${String(row.email)}`);
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: marker } });
  }
}

/** Counting an email-only person is only safe because fixtures are excluded. */
async function testList_excludesOurOwnFixtureRows() {
  const marker = `wlcase-fixture-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const seeded = await prisma.waitlist.create({
      data: { name: marker, email: fixtureEmail(marker), phone: null, variant: 'landing-page-a' },
    });
    const page = await findWaitlistPeople({ skip: 0, take: 100_000 });
    if (page.rows.some((row) => row.id === seeded.id)) {
      throw new Error('A @blackbox-test.dev fixture counted as a real waitlist person');
    }
    if (await findWaitlistPersonById(seeded.id)) {
      throw new Error('A fixture row was individually addressable as a real person');
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: marker } });
  }
}

/** The list total must count the same population the rows come from. */
async function testList_totalMatchesFilteredRows() {
  const marker = `wlcase-total-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    await prisma.waitlist.createMany({
      data: [
        {
          name: `${marker}-real`,
          email: `${marker}-real@waitlist-case.dev`,
          variant: 'landing-page-a',
        },
        { name: `${marker}-fix`, email: fixtureEmail(marker), variant: 'landing-page-a' },
      ],
    });
    const page = await findWaitlistPeople({ skip: 0, take: 100_000 });
    if (page.total !== page.rows.length) {
      throw new Error(`Total ${page.total} disagrees with ${page.rows.length} returned rows`);
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: { startsWith: marker } } });
  }
}

/**
 * The real-person rule has two implementations — isRealWaitlistPerson (TS, used
 * by the invite lookup and the signup metric) and realWaitlistPersonSql (used by
 * the paged list, its COUNT, and the user directory). They must agree on every
 * row or the list and its total silently disagree. This drives a matrix of
 * identities through both and diffs the verdicts.
 */
async function testRealPersonRule_sqlMatchesTypescript() {
  const marker = `wlcase-parity-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const seeds = [
    { label: 'phone-only', email: null, phone: uniquePhone() },
    { label: 'email-only', email: `${marker}-a@waitlist-case.dev`, phone: null },
    { label: 'both', email: `${marker}-b@waitlist-case.dev`, phone: uniquePhone() },
    { label: 'blank-phone', email: `${marker}-c@waitlist-case.dev`, phone: '   ' },
    { label: 'fixture-domain', email: fixtureEmail(`${marker}-d`), phone: null },
    {
      label: 'fixture-domain-with-phone',
      email: fixtureEmail(`${marker}-e`),
      phone: uniquePhone(),
    },
    { label: 'reserved-domain', email: `${marker}-f@example.com`, phone: null },
    { label: 'dotted-test-domain', email: `${marker}-g@something.test`, phone: null },
    {
      label: 'fixture-phone-1999',
      email: null,
      phone: `+1999${String(randomInt(0, 1e7)).padStart(7, '0')}`,
    },
    {
      label: 'fixture-phone-1555',
      email: null,
      phone: `+1555${String(randomInt(0, 1e7)).padStart(7, '0')}`,
    },
  ];
  try {
    const created = [];
    for (const seed of seeds) {
      created.push({
        seed,
        row: await prisma.waitlist.create({
          data: { name: `${marker}-${seed.label}`, email: seed.email, phone: seed.phone },
        }),
      });
    }

    const sqlIds = new Set(
      (
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "Waitlist" WHERE ${realWaitlistPersonSql()} AND "name" LIKE ${marker + '%'}`
        )
      ).map((row) => row.id)
    );

    const disagreements = created
      .map(({ seed, row }) => ({
        label: seed.label,
        ts: isRealWaitlistPerson(row),
        sql: sqlIds.has(row.id),
      }))
      .filter((verdict) => verdict.ts !== verdict.sql);

    if (disagreements.length > 0) {
      throw new Error(`TS and SQL real-person rules disagree: ${JSON.stringify(disagreements)}`);
    }

    // Guard against both implementations being uniformly wrong.
    const reals = created
      .filter(({ row }) => isRealWaitlistPerson(row))
      .map(({ seed }) => seed.label);
    const expected = ['phone-only', 'email-only', 'both', 'blank-phone'];
    if (JSON.stringify(reals.sort()) !== JSON.stringify([...expected].sort())) {
      throw new Error(
        `Expected exactly ${JSON.stringify(expected)} to count, got ${JSON.stringify(reals)}`
      );
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: { startsWith: marker } } });
  }
}

async function testList_paginatesNewestFirst() {
  const marker = `wlcase-wlpage-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const rows = [1, 2, 3].map((position) => ({
    name: `${marker}-${position}`,
    phone: `${uniquePhone()}${position}`,
    variant: 'gated-login',
    createdAt: new Date(`2099-01-0${position}T00:00:00.000Z`),
  }));
  try {
    await prisma.waitlist.createMany({ data: rows });
    const headers = authHeaders(tokenFor(ANDY_USER_ID, '+19729777432'));
    const first = await request(`${BASE_URL}/api/admin-health/waitlist?page=1&pageSize=2`, {
      headers,
    });
    const second = await request(`${BASE_URL}/api/admin-health/waitlist?page=2&pageSize=2`, {
      headers,
    });
    assertStatus(first.status, 200, first.data);
    assertStatus(second.status, 200, second.data);

    const firstBody = first.data as Record<string, unknown>;
    const secondBody = second.data as Record<string, unknown>;
    const firstPeople = firstBody.people as Array<Record<string, unknown>>;
    const secondPeople = secondBody.people as Array<Record<string, unknown>>;
    if (firstBody.page !== 1 || firstBody.pageSize !== 2) {
      throw new Error(`Unexpected first-page metadata: ${JSON.stringify(firstBody)}`);
    }
    if (secondBody.page !== 2 || secondBody.pageSize !== 2) {
      throw new Error(`Unexpected second-page metadata: ${JSON.stringify(secondBody)}`);
    }
    if (firstBody.totalPages !== Math.ceil(Number(firstBody.total) / 2)) {
      throw new Error(`Unexpected totalPages: ${JSON.stringify(firstBody)}`);
    }
    if (
      firstPeople[0]?.name !== `${marker}-3` ||
      firstPeople[1]?.name !== `${marker}-2` ||
      secondPeople[0]?.name !== `${marker}-1`
    ) {
      throw new Error(
        `Expected stable newest-first pages, got ${JSON.stringify({
          first: firstPeople.map((person) => person.name),
          second: secondPeople.map((person) => person.name),
        })}`
      );
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: { startsWith: marker } } });
  }
}

async function testInvite_nonAdminForbidden() {
  const res = await request(`${BASE_URL}/api/admin-health/waitlist/does-not-matter/invite`, {
    method: 'POST',
    headers: authHeaders(tokenFor(NON_ADMIN_USER_ID, '+15555550123')),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'POST /admin-health/waitlist invite non-admin');
}

async function testInvite_unknownId404() {
  const res = await request(
    `${BASE_URL}/api/admin-health/waitlist/nonexistent-${Date.now()}/invite`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
        'Idempotency-Key': `unknown-${Date.now()}`,
      },
    }
  );
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'POST /admin-health/waitlist invite unknown-id');
}

async function testInvite_missingIdempotencyKey400() {
  const res = await request(`${BASE_URL}/api/admin-health/waitlist/does-not-matter/invite`, {
    method: 'POST',
    headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponseSchema, res.data, 'POST invite missing idempotency key');
  if (!body.error.includes('Idempotency-Key')) {
    throw new Error(`Expected Idempotency-Key validation error, got ${body.error}`);
  }
}

// End-to-end invite: flags the matching account off the waitlist, stamps
// invitedAt, and (outside production) skips the real notifications so the test
// never contacts anyone. The flag does NOT grant access (usedInviteCode stays
// null). A re-send is idempotent.
async function testInvite_happyPathFlagsAndMarks() {
  const marker = `wlcase-invite-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniquePhone();
  try {
    await prisma.user.create({ data: { userId: marker, phone, usedInviteCode: null } });
    const created = await prisma.waitlist.create({
      data: { name: marker, phone, variant: 'gated-login' },
    });

    const res = await request(`${BASE_URL}/api/admin-health/waitlist/${created.id}/invite`, {
      method: 'POST',
      headers: {
        ...authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
        'Idempotency-Key': `${marker}-first`,
      },
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(WaitlistInviteResponseSchema, res.data, 'POST invite happy-path');
    if (body.smsSent) throw new Error('Non-production invite must not send a real SMS');
    if ((res.data as { emailSent?: unknown }).emailSent !== false) {
      throw new Error('Non-production invite must not send a real email');
    }
    if (!body.flagged || !body.hasAccount) {
      throw new Error(`Expected flagged + hasAccount, got ${JSON.stringify(body)}`);
    }

    const user = await prisma.user.findUnique({
      where: { userId: marker },
      select: { usedInviteCode: true, offWaitlistAt: true },
    });
    if (user?.offWaitlistAt === null || user?.offWaitlistAt === undefined) {
      throw new Error('Account was not flagged off the waitlist in DB');
    }
    if (user.usedInviteCode !== null) {
      throw new Error(`Invite must NOT grant access, but usedInviteCode = ${user.usedInviteCode}`);
    }
    const wl = await prisma.waitlist.findUnique({
      where: { id: created.id },
      select: { invitedAt: true },
    });
    if (wl?.invitedAt === null || wl?.invitedAt === undefined) {
      throw new Error('Waitlist row was not marked invited');
    }

    const resAgain = await request(`${BASE_URL}/api/admin-health/waitlist/${created.id}/invite`, {
      method: 'POST',
      headers: {
        ...authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
        'Idempotency-Key': `${marker}-resend`,
      },
    });
    assertStatus(resAgain.status, 200, resAgain.data);
    const bodyAgain = assertSchema(
      WaitlistInviteResponseSchema,
      resAgain.data,
      'POST invite re-send'
    );
    if (bodyAgain.flagged || !bodyAgain.alreadyOffWaitlist) {
      throw new Error(`Re-send should report alreadyOffWaitlist, got ${JSON.stringify(bodyAgain)}`);
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: marker } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

// The invite flags the matching account off the waitlist (offWaitlistAt) WITHOUT
// granting access, and is idempotent so a re-send never double-writes.
async function testMarkOffWaitlist_setsFlagIdempotent() {
  const marker = `wlcase-flag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniquePhone();
  try {
    await prisma.user.create({ data: { userId: marker, phone, usedInviteCode: null } });

    const first = await markOffWaitlistByPhone(phone);
    if (!first.flagged || first.alreadyOffWaitlist) {
      throw new Error(`First mark should set the flag, got ${JSON.stringify(first)}`);
    }
    const flagged = await prisma.user.findUnique({
      where: { userId: marker },
      select: { offWaitlistAt: true, usedInviteCode: true },
    });
    if (flagged?.offWaitlistAt === null || flagged?.offWaitlistAt === undefined) {
      throw new Error('offWaitlistAt was not set');
    }
    if (flagged.usedInviteCode !== null) {
      throw new Error('Flagging must not grant access (usedInviteCode must stay null)');
    }

    const second = await markOffWaitlistByPhone(phone);
    if (second.flagged || !second.alreadyOffWaitlist) {
      throw new Error(`Second mark must be a no-op, got ${JSON.stringify(second)}`);
    }
  } finally {
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

// getWaitlistPeople joins each phone-bearing signup to its account so admins
// can see who is still gated vs. already in the app.
async function testGetWaitlistPeople_derivesAccountStatus() {
  const marker = `wlcase-wlstatus-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniquePhone();
  try {
    await prisma.user.create({ data: { userId: marker, phone, usedInviteCode: null } });
    await prisma.waitlist.create({ data: { name: marker, phone, variant: 'gated-login' } });

    const gated = (await getWaitlistPeople()).people.find((person) => person.phone === phone);
    if (!gated) throw new Error('Seeded person missing from getWaitlistPeople');
    if (!gated.hasAccount || !gated.isGated) {
      throw new Error(`Expected hasAccount+isGated, got ${JSON.stringify(gated)}`);
    }

    // Flagging off the waitlist does NOT grant access, so they stay isGated
    // (still need a subscription / invite code) — only their onboarding view changes.
    await markOffWaitlistByPhone(phone);
    const stillGated = (await getWaitlistPeople()).people.find((person) => person.phone === phone);
    if (!stillGated || !stillGated.isGated) {
      throw new Error(`Flagged person must remain isGated, got ${JSON.stringify(stillGated)}`);
    }

    // Redeeming the master code is what actually clears the gate.
    await prisma.user.update({ where: { userId: marker }, data: { usedInviteCode: 181818 } });
    const cleared = (await getWaitlistPeople()).people.find((person) => person.phone === phone);
    if (!cleared || cleared.isGated) {
      throw new Error(`Person with a code must not be isGated, got ${JSON.stringify(cleared)}`);
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: marker } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

// The panel's isGated matches the real gate: an active subscription clears it
// even without a redeemed invite code.
async function testGetWaitlistPeople_subscriptionClearsGated() {
  const marker = `wlcase-wlsub-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniquePhone();
  try {
    await prisma.user.create({ data: { userId: marker, phone, usedInviteCode: null } });
    await prisma.waitlist.create({ data: { name: marker, phone, variant: 'gated-login' } });
    await prisma.subscription.create({
      data: {
        userId: marker,
        subscriptionTier: 20,
        stripeSubscriptionId: `sub_blackbox_${marker}`,
        stripeCustomerId: `cus_blackbox_${marker}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const person = (await getWaitlistPeople()).people.find((p) => p.phone === phone);
    if (!person || !person.hasAccount) throw new Error('Seeded subscribed person missing');
    if (person.isGated) {
      throw new Error(`Active subscription must clear isGated, got ${JSON.stringify(person)}`);
    }
  } finally {
    await prisma.subscription.deleteMany({ where: { userId: marker } });
    await prisma.waitlist.deleteMany({ where: { name: marker } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

// checkInviteCode surfaces the off-waitlist flag so onboarding can show the
// subscription view; the flag alone does NOT clear the gate.
async function testCheckInviteCode_reflectsOffWaitlistFlag() {
  const marker = `wlcase-chkflag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    await prisma.user.create({
      data: { userId: marker, usedInviteCode: null, offWaitlistAt: new Date() },
    });
    const result = await checkInviteCode(marker);
    if (!result.offWaitlist) throw new Error('Expected offWaitlist: true for a flagged user');
    if (!result.needsInviteCode) {
      throw new Error('Flag alone must not clear the gate (needsInviteCode should stay true)');
    }
  } finally {
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

// An active subscription clears the invite gate: subscription OR invite code.
async function testCheckInviteCode_activeSubscriptionClearsGate() {
  const marker = `wlcase-chksub-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const stripeId = `sub_blackbox_${marker}`;
  try {
    await prisma.user.create({ data: { userId: marker, usedInviteCode: null } });

    const gatedBefore = await checkInviteCode(marker);
    if (!gatedBefore.needsInviteCode) {
      throw new Error('User without a subscription or code must be gated');
    }

    await prisma.subscription.create({
      data: {
        userId: marker,
        subscriptionTier: 20,
        stripeSubscriptionId: stripeId,
        stripeCustomerId: `cus_blackbox_${marker}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const afterSub = await checkInviteCode(marker);
    if (afterSub.needsInviteCode) {
      throw new Error(
        'An active subscription must clear the gate (needsInviteCode should be false)'
      );
    }
  } finally {
    await prisma.subscription.deleteMany({ where: { userId: marker } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

async function runPool(
  tests: Array<{ name: string; fn: () => Promise<void> }>,
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(tests.length);
  let next = 0;
  async function worker() {
    while (next < tests.length) {
      const idx = next++;
      results[idx] = await runTest(tests[idx].name, tests[idx].fn);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, worker));
  return results;
}

async function main() {
  const tests = [
    { name: 'GET /api/admin-health/waitlist no auth -> 401', fn: testList_noAuth },
    { name: 'GET /api/admin-health/waitlist non-admin -> 403', fn: testList_nonAdminForbidden },
    {
      name: 'GET /api/admin-health/waitlist admin -> lists seeded person',
      fn: testList_adminListsSeededPerson,
    },
    {
      name: 'GET /api/admin-health/waitlist excludes whitespace-only phones from rows + total',
      fn: testList_excludesWhitespaceOnlyPhones,
    },
    {
      name: 'GET /api/admin-health/waitlist paginates newest-first',
      fn: testList_paginatesNewestFirst,
    },
    {
      name: 'waitlist list includes email-only signups (no phone required)',
      fn: testList_includesEmailOnlySignup,
    },
    {
      name: 'waitlist list excludes our own @blackbox-test.dev fixtures',
      fn: testList_excludesOurOwnFixtureRows,
    },
    {
      name: 'waitlist list total matches the filtered row set',
      fn: testList_totalMatchesFilteredRows,
    },
    {
      name: 'real-person rule: SQL and TypeScript implementations agree',
      fn: testRealPersonRule_sqlMatchesTypescript,
    },
    {
      name: 'POST /api/admin-health/waitlist/:id/invite non-admin -> 403',
      fn: testInvite_nonAdminForbidden,
    },
    {
      name: 'POST /api/admin-health/waitlist/:id/invite unknown id -> 404',
      fn: testInvite_unknownId404,
    },
    {
      name: 'POST /api/admin-health/waitlist/:id/invite missing idempotency key -> 400',
      fn: testInvite_missingIdempotencyKey400,
    },
    {
      name: 'POST /api/admin-health/waitlist/:id/invite flags + marks (no sends in dev)',
      fn: testInvite_happyPathFlagsAndMarks,
    },
    {
      name: 'markOffWaitlistByPhone sets the flag and is idempotent',
      fn: testMarkOffWaitlist_setsFlagIdempotent,
    },
    {
      name: 'getWaitlistPeople derives account + gate status',
      fn: testGetWaitlistPeople_derivesAccountStatus,
    },
    {
      name: 'getWaitlistPeople: active subscription clears isGated',
      fn: testGetWaitlistPeople_subscriptionClearsGated,
    },
    {
      name: 'checkInviteCode reflects the off-waitlist flag',
      fn: testCheckInviteCode_reflectsOffWaitlistFlag,
    },
    {
      name: 'checkInviteCode: active subscription clears the gate',
      fn: testCheckInviteCode_activeSubscriptionClearsGate,
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
    `\n${results.length - failed.length}/${results.length} admin-health-waitlist tests passed`
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
