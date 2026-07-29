#!/usr/bin/env tsx
/**
 * Black-box contract for waitlist contact identity.
 *
 * This is the single definition of "a real waitlist person" shared by the admin
 * list, the invite path, the signup metric, and the user directory. It exists
 * because those surfaces used to filter on `phone IS NOT NULL` as a stand-in
 * for "not fixture junk" — which hid every email-only signup, including the
 * entire public landing-form population, since that form collects no phone.
 *
 * The rule is: email OR phone, and not one of our own fixtures.
 */

import assert from 'node:assert/strict';

import {
  isRealWaitlistPerson,
  isWaitlistTestContact,
  normalizeWaitlistEmail,
  normalizeWaitlistPhone,
  WAITLIST_FIXTURE_EMAIL_ADDRESSES,
  WAITLIST_FIXTURE_EMAIL_DOMAINS,
} from '../../providers/waitlistIdentity';

function person(
  overrides: Partial<{ name: string | null; email: string | null; phone: string | null }> = {}
) {
  return { name: 'Ada Lovelace', email: 'ada@lovelace.dev', phone: null, ...overrides };
}

function testEmailOnlySignupCounts() {
  assert.equal(isRealWaitlistPerson(person({ email: 'ada@lovelace.dev', phone: null })), true);
}

function testPhoneOnlySignupCounts() {
  assert.equal(isRealWaitlistPerson(person({ email: null, phone: '+525562115791' })), true);
}

function testRowWithNeitherIdentifierDoesNotCount() {
  assert.equal(isRealWaitlistPerson(person({ email: null, phone: null })), false);
  assert.equal(isRealWaitlistPerson(person({ email: '   ', phone: '  ' })), false);
}

/**
 * The regression that made every waitlist surface undercount. These domains are
 * NOT RFC-reserved — they are `.dev` names our own suites picked — so the
 * generic example.com/.test/.invalid rules never matched them, and prod
 * accumulated thousands of rows that looked like real email-only signups.
 */
function testOurOwnFixtureDomainsAreClassifiedAsTests() {
  for (const domain of WAITLIST_FIXTURE_EMAIL_DOMAINS) {
    const row = person({ name: 'Someone Real', email: `someone@${domain}`, phone: null });
    assert.equal(isWaitlistTestContact(row), true, `${domain} should be a fixture`);
    assert.equal(isRealWaitlistPerson(row), false, `${domain} must not count as a person`);
  }
}

/**
 * Harness accounts on a real domain: the chat-lifecycle ratchet mints its user
 * under roselabs.ai, and the contact backfill copies it into Waitlist where it
 * reads as a real email-only signup. roselabs.ai as a whole must stay allowed.
 */
function testKnownHarnessAddressesAreClassifiedAsTests() {
  for (const address of WAITLIST_FIXTURE_EMAIL_ADDRESSES) {
    const row = person({ name: null, email: address, phone: null });
    assert.equal(isWaitlistTestContact(row), true, address);
    assert.equal(isRealWaitlistPerson(row), false, address);
    // Case and padding must not smuggle it past the check.
    assert.equal(isWaitlistTestContact(person({ email: `  ${address.toUpperCase()} ` })), true);
  }
  assert.equal(
    isRealWaitlistPerson(person({ name: 'Andy Prevalsky', email: 'andy@roselabs.ai' })),
    true,
    'a real teammate on roselabs.ai must still count'
  );
}

function testRfcReservedDomainsStayClassifiedAsTests() {
  for (const email of [
    'a@example.com',
    'a@example.net',
    'a@example.org',
    'a@example.test',
    'a@anything.test',
    'a@invalid',
    'a@anything.invalid',
  ]) {
    assert.equal(isWaitlistTestContact(person({ email })), true, email);
  }
}

function testReservedNamesAndPhonesStayClassifiedAsTests() {
  assert.equal(isWaitlistTestContact(person({ name: 'Test User' })), true);
  assert.equal(isWaitlistTestContact(person({ name: 'blackbox-runner' })), true);
  assert.equal(isWaitlistTestContact(person({ name: 'benchmark_case' })), true);
  assert.equal(isWaitlistTestContact(person({ email: null, phone: '+15551234567' })), true);
  assert.equal(isWaitlistTestContact(person({ email: null, phone: '+19995550000' })), true);
}

function testRealPeopleAreNotMisclassified() {
  const reals = [
    person({
      name: 'Aurora Portillo',
      email: 'aurora.portillo@collectiveacademy.com',
      phone: '+528111952469',
    }),
    person({ name: 'Maite Muniz', email: null, phone: '+525562115791' }),
    person({ name: 'Karla Huerta', email: 'khuerta@apb.mx', phone: null }),
    // A real person whose name merely starts with a reserved word but is not it.
    person({ name: 'Testa Rossa', email: 'testa@rossa.it', phone: null }),
  ];
  for (const row of reals) {
    assert.equal(isWaitlistTestContact(row), false, `${row.name} misclassified as a fixture`);
    assert.equal(isRealWaitlistPerson(row), true, `${row.name} should count`);
  }
}

function testNormalizationIsCanonical() {
  assert.equal(normalizeWaitlistEmail('  Ada@Lovelace.DEV '), 'ada@lovelace.dev');
  assert.equal(normalizeWaitlistEmail('   '), null);
  assert.equal(normalizeWaitlistPhone('+52 55 3939 7133'), '+525539397133');
  // Unicode bidi marks survive pasted spreadsheet cells; digits-only wins.
  assert.equal(normalizeWaitlistPhone('‪+52 55 3939 7133‬'), '+525539397133');
  assert.equal(normalizeWaitlistPhone('  '), null);
}

function main() {
  testEmailOnlySignupCounts();
  testPhoneOnlySignupCounts();
  testRowWithNeitherIdentifierDoesNotCount();
  testOurOwnFixtureDomainsAreClassifiedAsTests();
  testKnownHarnessAddressesAreClassifiedAsTests();
  testRfcReservedDomainsStayClassifiedAsTests();
  testReservedNamesAndPhonesStayClassifiedAsTests();
  testRealPeopleAreNotMisclassified();
  testNormalizationIsCanonical();
  console.log('✅ waitlist contact identity contract passed');
}

main();
