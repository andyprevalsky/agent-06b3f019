#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { planWaitlistAccessReset } from '../../domains/waitlist/accessReset';

// Refuse to seed fixtures into prod when this file is run directly (bypassing
// the runner, which is what put ~2,690 fixture rows in the prod Waitlist table).
import './assertLocalDatabase';

const protectedIds = new Set(['andy', 'tamy', 'aman']);
const timestamp = new Date('2026-07-23T00:00:00.000Z');
const plan = planWaitlistAccessReset(
  [
    {
      userId: 'andy',
      isAnonymous: false,
      usedInviteCode: 181818,
      offWaitlistAt: timestamp,
    },
    {
      userId: 'tamy',
      isAnonymous: false,
      usedInviteCode: null,
      offWaitlistAt: timestamp,
    },
    {
      userId: 'aman',
      isAnonymous: false,
      usedInviteCode: 181818,
      offWaitlistAt: null,
    },
    {
      userId: 'customer-with-access',
      isAnonymous: false,
      usedInviteCode: 181818,
      offWaitlistAt: timestamp,
    },
    {
      userId: 'customer-already-gated',
      isAnonymous: false,
      usedInviteCode: null,
      offWaitlistAt: null,
    },
    {
      userId: 'anonymous-agent',
      isAnonymous: true,
      usedInviteCode: 181818,
      offWaitlistAt: timestamp,
    },
  ],
  protectedIds
);

assert.deepEqual(plan.targetUserIds, ['customer-already-gated', 'customer-with-access']);
assert.deepEqual(plan.protectedUserIds, ['aman', 'andy', 'tamy']);
assert.deepEqual(plan.protectedUsersNeedingAccess, ['tamy']);
assert.equal(plan.targetsNeedingReset, 1);

const resetScript = readFileSync(
  resolve(process.cwd(), 'scripts', 'move-users-to-waitlist.ts'),
  'utf8'
);
const transactionStart = resetScript.indexOf('await prisma.$transaction(async (tx)');
const inTransactionSubscriptionCheck = resetScript.indexOf(
  'activeTargetSubscriptionCount(tx, plan.targetUserIds)',
  transactionStart
);
const firstAccessWrite = resetScript.indexOf('await tx.user.updateMany', transactionStart);
assert.ok(transactionStart >= 0, 'access reset must use an interactive transaction');
assert.ok(
  inTransactionSubscriptionCheck > transactionStart &&
    inTransactionSubscriptionCheck < firstAccessWrite,
  'active subscriptions must be rechecked inside the transaction before either access write'
);

assert.throws(
  () =>
    planWaitlistAccessReset(
      [
        {
          userId: 'andy',
          isAnonymous: false,
          usedInviteCode: 181818,
          offWaitlistAt: null,
        },
      ],
      protectedIds
    ),
  /Missing protected users: aman, tamy/
);

console.log('✅ waitlist access-reset planner contract passed');
