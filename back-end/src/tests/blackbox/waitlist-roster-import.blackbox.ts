#!/usr/bin/env tsx
/**
 * Black-box contract for the manual waitlist roster importer.
 *
 * The operational script (scripts/import-waitlist-roster.ts) reads a TSV of
 * hand-curated people and folds them into Waitlist. Waitlist.email and
 * Waitlist.phone are both UNIQUE and the Waitlist_contact_present CHECK
 * requires at least one of them, so the planner must never emit a create that
 * duplicates an identifier and never emit an entry with no contact at all.
 */

import assert from 'node:assert/strict';

import {
  parseRoster,
  planRosterImport,
  variantForCategory,
  type RosterExistingRow,
} from '../../domains/waitlist/rosterImport';

function existing(overrides: Partial<RosterExistingRow> = {}): RosterExistingRow {
  return { id: 'row-1', email: null, phone: null, ...overrides };
}

function applyPlan(
  rows: RosterExistingRow[],
  plan: ReturnType<typeof planRosterImport>
): RosterExistingRow[] {
  const next = rows.map((row) => ({ ...row }));
  for (const update of plan.updates) {
    const row = next.find((candidate) => candidate.id === update.id);
    assert.ok(row, `Missing row ${update.id}`);
    Object.assign(row, update.data);
  }
  for (const [index, create] of plan.creates.entries()) {
    next.push({ id: `created-${index}`, email: create.email, phone: create.phone });
  }
  return next;
}

function testParsesTabSeparatedRosterAndSkipsCommentsAndBlanks() {
  const { entries, errors } = parseRoster(
    [
      '# roster comment',
      '',
      'Ada Lovelace\tada@lovelace.dev\t14155552671\tInvestor',
      'Grace Hopper\t\t525562115791\tMentorship',
      'Alan Turing\talan@turing.dev\t\tPersonal',
    ].join('\n')
  );

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[1], {
    name: 'Grace Hopper',
    email: null,
    phone: '525562115791',
    category: 'Mentorship',
  });
}

function testRejectsRowsThatViolateTheContactPresentConstraint() {
  const { entries, errors } = parseRoster('Nobody\t\t\tInvestor');

  assert.equal(entries.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /neither email nor phone/);
}

function testRejectsMalformedRowsInsteadOfDroppingThemSilently() {
  const missingColumns = parseRoster('Ada\tada@lovelace.dev');
  assert.equal(missingColumns.entries.length, 0);
  assert.match(missingColumns.errors[0], /expected 4 tab-separated columns/);

  const missingName = parseRoster('\tada@lovelace.dev\t\tInvestor');
  assert.equal(missingName.entries.length, 0);
  assert.match(missingName.errors[0], /missing name/);

  const missingCategory = parseRoster('Ada\tada@lovelace.dev\t\t');
  assert.equal(missingCategory.entries.length, 0);
  assert.match(missingCategory.errors[0], /missing a category/);
}

function testCategoryRidesOnTheVariantSourceTag() {
  assert.equal(variantForCategory('Collective'), 'manual-import:collective');
  assert.equal(variantForCategory(' Mentorship '), 'manual-import:mentorship');

  const plan = planRosterImport(
    [{ name: 'Ada Lovelace', email: 'ada@lovelace.dev', phone: null, category: 'Investor' }],
    []
  );
  assert.equal(plan.creates[0].variant, 'manual-import:investor');
}

function testNormalizesEmailAndPhoneOnCreate() {
  const plan = planRosterImport(
    [
      {
        name: 'Ada Lovelace',
        // Trailing whitespace + mixed case + a phone carrying formatting and
        // unicode bidi marks, exactly as pasted rosters arrive.
        email: '  Ada@Lovelace.dev ',
        phone: '‪+52 55 3939 7133‬',
        category: 'Collective',
      },
    ],
    []
  );

  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].email, 'ada@lovelace.dev');
  assert.equal(plan.creates[0].phone, '+525539397133');
}

function testFillsMissingEmailOnAPhoneMatchedRow() {
  const rows = [existing({ id: 'gated-1', phone: '+529991089424' })];
  const plan = planRosterImport(
    [
      {
        name: 'Veronica',
        email: 'vero@example.com',
        phone: '529991089424',
        category: 'Collective',
      },
    ],
    rows
  );

  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.updates, [
    { name: 'Veronica', id: 'gated-1', data: { email: 'vero@example.com' } },
  ]);
}

function testNeverOverwritesAContactDetailAlreadyOnFile() {
  const rows = [existing({ id: 'row-1', email: 'onfile@example.com', phone: '+529991089424' })];
  const plan = planRosterImport(
    [{ name: 'Veronica', email: 'different@example.com', phone: '529991089424', category: 'C' }],
    rows
  );

  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /already on waitlist \(row-1\)/);
}

function testNeverClaimsAnIdentifierAnotherRowOwns() {
  // The email belongs to a different row than the phone match, so filling it in
  // would violate Waitlist_email_key.
  const rows = [
    existing({ id: 'phone-row', phone: '+529991089424' }),
    existing({ id: 'email-row', email: 'vero@example.com' }),
  ];
  const plan = planRosterImport(
    [{ name: 'Veronica', email: 'vero@example.com', phone: '529991089424', category: 'C' }],
    rows
  );

  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skipped.length, 1);
}

function testDuplicateWithinOneRosterCollapsesToASingleCreate() {
  const plan = planRosterImport(
    [
      { name: 'Ada Lovelace', email: 'ada@lovelace.dev', phone: '14155552671', category: 'C' },
      { name: 'Ada L.', email: 'ada@lovelace.dev', phone: null, category: 'C' },
      { name: 'A. Lovelace', email: null, phone: '+1 415 555 2671', category: 'C' },
    ],
    []
  );

  assert.equal(plan.creates.length, 1);
  assert.equal(plan.skipped.length, 2);
}

function testRerunOfAnAppliedRosterIsANoOp() {
  const entries = [
    { name: 'Ada Lovelace', email: 'ada@lovelace.dev', phone: '14155552671', category: 'Investor' },
    { name: 'Grace Hopper', email: null, phone: '525562115791', category: 'Mentorship' },
    { name: 'Alan Turing', email: 'alan@turing.dev', phone: null, category: 'Personal' },
  ];

  const first = planRosterImport(entries, []);
  assert.equal(first.creates.length, 3);

  const afterApply = applyPlan([], first);
  const second = planRosterImport(entries, afterApply);

  assert.equal(second.creates.length, 0);
  assert.equal(second.updates.length, 0);
  assert.equal(second.skipped.length, 3);
}

function testEveryPlannedCreateCarriesAtLeastOneContactIdentifier() {
  const plan = planRosterImport(
    [
      { name: 'Ada Lovelace', email: 'ada@lovelace.dev', phone: null, category: 'C' },
      { name: 'Grace Hopper', email: null, phone: '525562115791', category: 'M' },
      { name: 'Ghost', email: '   ', phone: '  ', category: 'M' },
    ],
    []
  );

  for (const create of plan.creates) {
    assert.ok(
      create.email !== null || create.phone !== null,
      `${create.name} would violate Waitlist_contact_present`
    );
  }
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'no email or phone');
}

function main() {
  testParsesTabSeparatedRosterAndSkipsCommentsAndBlanks();
  testRejectsRowsThatViolateTheContactPresentConstraint();
  testRejectsMalformedRowsInsteadOfDroppingThemSilently();
  testCategoryRidesOnTheVariantSourceTag();
  testNormalizesEmailAndPhoneOnCreate();
  testFillsMissingEmailOnAPhoneMatchedRow();
  testNeverOverwritesAContactDetailAlreadyOnFile();
  testNeverClaimsAnIdentifierAnotherRowOwns();
  testDuplicateWithinOneRosterCollapsesToASingleCreate();
  testRerunOfAnAppliedRosterIsANoOp();
  testEveryPlannedCreateCarriesAtLeastOneContactIdentifier();
  console.log('✅ waitlist roster import planner contract passed');
}

main();
