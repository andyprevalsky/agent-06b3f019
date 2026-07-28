#!/usr/bin/env tsx
/**
 * Black-box tests for who counts as a real waitlist person.
 *
 * Split out of admin-health-waitlist.blackbox.ts to keep each suite inside the
 * strict per-file line budget; the runner discovers suites by filename, so this
 * registers as its own domain.
 *
 * The rule is email OR phone, minus our own fixtures. It replaced a
 * `phone IS NOT NULL` filter that was really a stand-in for "not fixture junk"
 * and silently hid every email-only signup.
 *
 * Invariants covered:
 *   - email-only signups appear in the list; @blackbox-test.dev fixtures do not
 *   - the list total counts exactly the rows the list returns
 *   - the TS predicate and the SQL fragment agree across an identity matrix, so
 *     the paged list and its COUNT can never disagree
 *
 * Usage:
 *   bash scripts/run-blackbox-tests.sh admin-health-waitlist-filter
 */

import { randomInt } from 'node:crypto';

import { config } from 'dotenv';
import { Prisma } from '@prisma/client';

import { findWaitlistPeople, findWaitlistPersonById } from '../../domains/admin-health/repo';
import { prisma } from '../../providers/database';
import { isRealWaitlistPerson, realWaitlistPersonSql } from '../../providers/waitlistIdentity';

// Refuse to seed fixtures into prod when this file is run directly (bypassing
// the runner, which is what put ~2,690 fixture rows in the prod Waitlist table).
import './assertLocalDatabase';
config();

/**
 * A number that reads as a real signup but can never route to a handset: NANP
 * 555-0100..555-0199 is the officially fictional subscriber range. It avoids
 * the +1555/+1999 prefixes, which the real-person filter treats as fixtures.
 */
function uniquePhone(): string {
  const areaCode = randomInt(200, 990);
  return `+1${areaCode}555${String(randomInt(100, 200)).padStart(4, '0')}`;
}

/** An identity the real-people filter must reject, for exclusion assertions. */
function fixtureEmail(marker: string): string {
  return `${marker}@blackbox-test.dev`;
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
    // Non-normalized and malformed addresses: the SQL twin compared untrimmed
    // values and took split_part(email,'@',2) — the SECOND segment — while the
    // TS rule trims and reads the LAST segment. Both classified these rows
    // differently, so a padded or double-'@' fixture counted in the list/COUNT
    // while the in-memory filter rejected it.
    { label: 'padded-fixture-domain', email: `  ${fixtureEmail(`${marker}-h`)}  `, phone: null },
    { label: 'padded-reserved-domain', email: ` ${marker}-i@example.com `, phone: null },
    { label: 'uppercase-fixture-domain', email: `${marker}-J@BLACKBOX-TEST.DEV`, phone: null },
    { label: 'double-at-fixture', email: `${marker}-k@inner@blackbox-test.dev`, phone: null },
    { label: 'double-at-real', email: `${marker}-l@inner@collectiveacademy.com`, phone: null },
    { label: 'bare-invalid-domain', email: `${marker}-m@invalid`, phone: null },
    { label: 'dotted-invalid-domain', email: `${marker}-n@host.invalid`, phone: null },
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
    // `double-at-real` counts on purpose: its LAST '@' segment is a real domain,
    // so it is a real person. Its fixture twin `double-at-fixture` must not.
    const expected = ['phone-only', 'email-only', 'both', 'blank-phone', 'double-at-real'];
    if (JSON.stringify(reals.sort()) !== JSON.stringify([...expected].sort())) {
      throw new Error(
        `Expected exactly ${JSON.stringify(expected)} to count, got ${JSON.stringify(reals)}`
      );
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: { startsWith: marker } } });
  }
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const started = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - started;
    console.log(`\u2705 ${name} (${durationMs}ms)`);
    return { name, passed: true, durationMs };
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\u274c ${name} (${durationMs}ms)`);
    console.log(`   ${message}`);
    return { name, passed: false, error: message, durationMs };
  }
}

async function main() {
  const tests = [
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
  ];

  const results: TestResult[] = [];
  for (const test of tests) {
    results.push(await runTest(test.name, test.fn));
  }

  const passed = results.filter((result) => result.passed).length;
  console.log(`\n${passed}/${results.length} admin-health-waitlist-filter tests passed`);
  await prisma.$disconnect();
  if (passed !== results.length) process.exit(1);
}

void main();
