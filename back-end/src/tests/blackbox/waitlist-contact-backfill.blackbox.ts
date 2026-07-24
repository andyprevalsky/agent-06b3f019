#!/usr/bin/env tsx
/**
 * Black-box contract for the customer-contact waitlist backfill planner.
 *
 * The operational script loads customer-owned identifiers from public.User and
 * auth.users. Address-book Person rows and synthetic AgentIdentity rows never
 * enter this planner.
 */

import assert from 'node:assert/strict';

import {
  isWaitlistTestContact,
  planWaitlistContactBackfill,
  type WaitlistBackfillExistingRow,
  type WaitlistContactSource,
} from '../../domains/waitlist/contactBackfill';

const day = (value: number) => new Date(`2026-01-${String(value).padStart(2, '0')}T00:00:00.000Z`);

function applyPlan(
  existingRows: WaitlistBackfillExistingRow[],
  plan: ReturnType<typeof planWaitlistContactBackfill>
): WaitlistBackfillExistingRow[] {
  const rows = existingRows.map((row) => ({ ...row }));
  for (const update of plan.updates) {
    const row = rows.find((candidate) => candidate.id === update.id);
    assert.ok(row, `Missing row ${update.id}`);
    Object.assign(row, update.data);
  }
  for (const [index, create] of plan.creates.entries()) {
    rows.push({ id: `created-${index}`, ...create });
  }
  return rows;
}

function source(overrides: Partial<WaitlistContactSource> = {}): WaitlistContactSource {
  return {
    sourceId: 'user-1',
    name: 'Ada Lovelace',
    email: 'Ada@Lovelace.dev ',
    phone: ' +1 (323) 449-8210 ',
    seenAt: day(2),
    ...overrides,
  };
}

function existing(
  overrides: Partial<WaitlistBackfillExistingRow> = {}
): WaitlistBackfillExistingRow {
  return {
    id: 'waitlist-1',
    name: '',
    email: null,
    phone: null,
    variant: null,
    createdAt: day(10),
    ...overrides,
  };
}

function testCreatesOneCanonicalRowPerCustomerIdentity() {
  const plan = planWaitlistContactBackfill(
    [
      source(),
      source({
        name: null,
        email: 'ada@lovelace.dev',
        phone: '13234498210',
        seenAt: day(1),
      }),
      source({
        sourceId: 'empty-contact',
        name: 'Ignored',
        email: ' ',
        phone: '---',
      }),
    ],
    []
  );

  assert.equal(plan.sourceEmailCount, 1);
  assert.equal(plan.sourcePhoneCount, 1);
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.deepEqual(plan.creates[0], {
    name: 'Ada Lovelace',
    email: 'ada@lovelace.dev',
    phone: '+13234498210',
    variant: 'database-contact-backfill',
    createdAt: day(1),
  });
}

function testAttachesMissingPhoneAndPreservesExistingTimestamp() {
  const rows = [existing({ email: 'ADA@Lovelace.dev', createdAt: day(10) })];
  const plan = planWaitlistContactBackfill([source({ seenAt: day(1) })], rows);

  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.updates, [
    {
      id: 'waitlist-1',
      data: { name: 'Ada Lovelace', phone: '+13234498210' },
    },
  ]);
  assert.equal(rows[0].createdAt.toISOString(), day(10).toISOString());
}

function testAttachesMissingEmailByPhone() {
  const plan = planWaitlistContactBackfill(
    [source()],
    [existing({ name: 'Ada', phone: '13234498210' })]
  );

  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.updates, [
    {
      id: 'waitlist-1',
      data: { email: 'ada@lovelace.dev' },
    },
  ]);
}

function testKeepsEveryUniqueIdentifierWhenOneRowCannotHoldBoth() {
  const plan = planWaitlistContactBackfill(
    [source()],
    [existing({ email: 'ada@lovelace.dev', phone: '+15555550123' })]
  );

  assert.deepEqual(plan.updates, [
    {
      id: 'waitlist-1',
      data: { name: 'Ada Lovelace' },
    },
  ]);
  assert.deepEqual(plan.creates, [
    {
      name: 'Ada Lovelace',
      email: null,
      phone: '+13234498210',
      variant: 'database-contact-backfill',
      createdAt: day(2),
    },
  ]);
}

function testRerunIsIdempotent() {
  const sources = [source()];
  const firstPlan = planWaitlistContactBackfill(sources, [existing({ email: 'ada@lovelace.dev' })]);
  const secondPlan = planWaitlistContactBackfill(
    sources,
    applyPlan(
      [
        existing({
          email: 'ada@lovelace.dev',
        }),
      ],
      firstPlan
    )
  );

  assert.equal(secondPlan.creates.length, 0);
  assert.equal(secondPlan.updates.length, 0);
  assert.equal(secondPlan.missingEmailCount, 0);
  assert.equal(secondPlan.missingPhoneCount, 0);
}

function testCoveredSingleIdentifiersDoNotCreateDuplicates() {
  const emailOnly = planWaitlistContactBackfill(
    [source({ phone: null })],
    [existing({ name: 'Ada', email: 'ada@lovelace.dev' })]
  );
  const phoneOnly = planWaitlistContactBackfill(
    [source({ email: null })],
    [existing({ name: 'Ada', phone: '+13234498210' })]
  );

  assert.equal(emailOnly.creates.length, 0);
  assert.equal(emailOnly.updates.length, 0);
  assert.equal(phoneOnly.creates.length, 0);
  assert.equal(phoneOnly.updates.length, 0);
}

function testReservedFixtureContactsAreExcluded() {
  assert.equal(
    isWaitlistTestContact({ name: 'Customer', email: null, phone: '+1 (555) 123-4567' }),
    true
  );
  assert.equal(
    isWaitlistTestContact({ name: 'Customer', email: 'fixture@example.com', phone: null }),
    true
  );
  assert.equal(isWaitlistTestContact({ name: 'Test User', email: null, phone: null }), true);
  assert.equal(isWaitlistTestContact({ name: 'Andy', email: null, phone: '+19729777432' }), false);
  assert.equal(
    isWaitlistTestContact({
      name: 'Ada Lovelace',
      email: 'ada@lovelace.dev',
      phone: '+14155552671',
    }),
    false
  );
}

function main() {
  testCreatesOneCanonicalRowPerCustomerIdentity();
  testAttachesMissingPhoneAndPreservesExistingTimestamp();
  testAttachesMissingEmailByPhone();
  testKeepsEveryUniqueIdentifierWhenOneRowCannotHoldBoth();
  testRerunIsIdempotent();
  testCoveredSingleIdentifiersDoNotCreateDuplicates();
  testReservedFixtureContactsAreExcluded();
  console.log('✅ waitlist customer-contact backfill planner contract passed');
}

main();
