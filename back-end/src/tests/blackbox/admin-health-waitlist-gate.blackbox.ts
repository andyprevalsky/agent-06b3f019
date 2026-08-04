#!/usr/bin/env tsx
/**
 * Black-box tests for the waitlist invite gate.
 *
 * Split out of admin-health-waitlist.blackbox.ts to keep each suite inside the
 * strict per-file line budget; the runner discovers suites by filename, so this
 * registers as its own domain.
 *
 * Invariants covered:
 *   - gated sign-up records the account's email + name onto the waitlist row,
 *     and backfills them onto an existing phone-only row on a later login
 *   - details already on the row (admin-curated or roster-imported) are never
 *     clobbered, and a UNIQUE email owned by another row is survivable
 *   - markOffWaitlistByPhone stamps offWaitlistAt and is idempotent
 *   - checkInviteCode reflects the flag; an active subscription clears the gate
 *
 * Usage:
 *   bash scripts/run-blackbox-tests.sh admin-health-waitlist-gate
 */

import { config } from 'dotenv';

import { checkInviteCode } from '../../domains/invite-codes/service';
import { prisma } from '../../providers/database';
import { markOffWaitlistByPhone } from '../../providers/inviteGate';
import { uniqueRealWaitlistPhone } from './waitlistTestPhone';

// Refuse to seed fixtures into prod when this file is run directly (bypassing
// the runner, which is what put ~2,690 fixture rows in the prod Waitlist table).
import './assertLocalDatabase';
config();
// checkInviteCode surfaces the off-waitlist flag so onboarding can show the
// subscription view; the flag alone does NOT clear the gate.
/**
 * Sign-up captures an email and a name onto User, but the gated waitlist row
 * used to carry only the phone — so the admin waitlist read "no email on file"
 * for people whose address we already held one table over.
 */
async function testGatedSignup_recordsEmailAndNameOnTheWaitlistRow() {
  const marker = `wlcase-gated-contact-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniqueRealWaitlistPhone();
  const email = `${marker}@waitlist-case.dev`;
  try {
    await prisma.user.create({
      data: { userId: marker, phone, email, name: 'Ada Lovelace', usedInviteCode: null },
    });
    await checkInviteCode(marker, phone);

    const row = await prisma.waitlist.findUnique({ where: { phone } });
    if (!row) throw new Error('Gated signup did not create a waitlist row');
    if (row.email !== email) throw new Error(`Expected email ${email}, got ${String(row.email)}`);
    if (row.name !== 'Ada Lovelace') throw new Error(`Expected the name, got ${row.name}`);
  } finally {
    await prisma.waitlist.deleteMany({ where: { phone } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

/** A later login must fill a blank email left by an earlier phone-only row. */
async function testGatedSignup_backfillsEmailOntoAnExistingPhoneOnlyRow() {
  const marker = `wlcase-gated-backfill-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniqueRealWaitlistPhone();
  const email = `${marker}@waitlist-case.dev`;
  try {
    // The shape every pre-existing gated-login row has in production.
    await prisma.waitlist.create({ data: { phone, name: '', variant: 'gated-login' } });
    await prisma.user.create({
      data: { userId: marker, phone, email, name: 'Grace Hopper', usedInviteCode: null },
    });
    await checkInviteCode(marker, phone);

    const row = await prisma.waitlist.findUnique({ where: { phone } });
    if (row?.email !== email)
      throw new Error(`Expected backfilled ${email}, got ${String(row?.email)}`);
    if (row?.name !== 'Grace Hopper')
      throw new Error(`Expected backfilled name, got ${String(row?.name)}`);
  } finally {
    await prisma.waitlist.deleteMany({ where: { phone } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

/** Details already on the row (admin-curated or roster-imported) must survive. */
async function testGatedSignup_neverClobbersDetailsAlreadyOnTheRow() {
  const marker = `wlcase-gated-noclobber-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniqueRealWaitlistPhone();
  const curated = `${marker}-curated@waitlist-case.dev`;
  try {
    await prisma.waitlist.create({
      data: { phone, name: 'Curated Name', email: curated, variant: 'manual-import:investor' },
    });
    await prisma.user.create({
      data: {
        userId: marker,
        phone,
        email: `${marker}-account@waitlist-case.dev`,
        name: 'Account Name',
        usedInviteCode: null,
      },
    });
    await checkInviteCode(marker, phone);

    const row = await prisma.waitlist.findUnique({ where: { phone } });
    if (row?.email !== curated)
      throw new Error(`Curated email was clobbered: ${String(row?.email)}`);
    if (row?.name !== 'Curated Name')
      throw new Error(`Curated name was clobbered: ${String(row?.name)}`);
  } finally {
    await prisma.waitlist.deleteMany({ where: { phone } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

/**
 * Waitlist.email is UNIQUE. When a roster import already owns the address, the
 * gate check must still record the signup rather than blowing up on P2002.
 */
async function testGatedSignup_survivesEmailAlreadyOwnedByAnotherRow() {
  const marker = `wlcase-gated-dupe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniqueRealWaitlistPhone();
  const otherPhone = uniqueRealWaitlistPhone();
  const email = `${marker}@waitlist-case.dev`;
  try {
    await prisma.waitlist.create({
      data: { phone: otherPhone, name: 'Roster Row', email, variant: 'manual-import:collective' },
    });
    await prisma.user.create({
      data: { userId: marker, phone, email, name: 'Dup Email', usedInviteCode: null },
    });

    const result = await checkInviteCode(marker, phone);
    if (!result.needsInviteCode) throw new Error('Gate check must still report the gate');

    const row = await prisma.waitlist.findUnique({ where: { phone } });
    if (!row) throw new Error('Gate check must still record the signup');
    if (row.email !== null)
      throw new Error(`Must not steal another row's address, got ${String(row.email)}`);
    const owner = await prisma.waitlist.findUnique({ where: { phone: otherPhone } });
    if (owner?.email !== email) throw new Error('The owning row must keep its address');
  } finally {
    await prisma.waitlist.deleteMany({ where: { phone: { in: [phone, otherPhone] } } });
    await prisma.user.deleteMany({ where: { userId: marker } });
  }
}

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

// The invite flags the matching account off the waitlist (offWaitlistAt) WITHOUT
// granting access, and is idempotent so a re-send never double-writes.
async function testMarkOffWaitlist_setsFlagIdempotent() {
  const marker = `wlcase-flag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniqueRealWaitlistPhone();
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
      name: 'gated signup records email + name on the waitlist row',
      fn: testGatedSignup_recordsEmailAndNameOnTheWaitlistRow,
    },
    {
      name: 'gated signup backfills email + name onto an existing phone-only row',
      fn: testGatedSignup_backfillsEmailOntoAnExistingPhoneOnlyRow,
    },
    {
      name: 'gated signup never clobbers details already on the row',
      fn: testGatedSignup_neverClobbersDetailsAlreadyOnTheRow,
    },
    {
      name: 'gated signup survives an email already owned by another row',
      fn: testGatedSignup_survivesEmailAlreadyOwnedByAnotherRow,
    },
    {
      name: 'markOffWaitlistByPhone sets the flag and is idempotent',
      fn: testMarkOffWaitlist_setsFlagIdempotent,
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

  const results: TestResult[] = [];
  for (const test of tests) {
    results.push(await runTest(test.name, test.fn));
  }

  const passed = results.filter((result) => result.passed).length;
  console.log(`\n${passed}/${results.length} admin-health-waitlist-gate tests passed`);
  await prisma.$disconnect();
  if (passed !== results.length) process.exit(1);
}

void main();
