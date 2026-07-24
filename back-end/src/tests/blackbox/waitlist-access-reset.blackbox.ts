#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { planWaitlistAccessReset } from '../../domains/waitlist/accessReset';

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
