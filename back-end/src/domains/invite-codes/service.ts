/**
 * Invite-codes domain service — business logic.
 */

import {
  MAX_INVITE_CODE_USES,
  MASTER_INVITE_CODE,
  INVITE_CODE_MIN,
  INVITE_CODE_RANGE,
} from './config';
import type { MyCodeResponse, UseCodeResponse, CheckResponse } from './types';
import * as repo from './repo';
import { createInitialCredit } from '../../providers/credits';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class AlreadyUsedInviteCodeError extends Error {
  constructor() {
    super('You have already used an invite code');
    this.name = 'AlreadyUsedInviteCodeError';
  }
}

export class InvalidInviteCodeError extends Error {
  constructor() {
    super('Valid invite code is required');
    this.name = 'InvalidInviteCodeError';
  }
}

export class InviteCodeNotFoundError extends Error {
  constructor() {
    super('Invalid invite code');
    this.name = 'InviteCodeNotFoundError';
  }
}

export class InviteCodeExhaustedError extends Error {
  constructor() {
    super('This invite code has no uses remaining');
    this.name = 'InviteCodeExhaustedError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique 6-digit invite code.
 */
function generateInviteCode(): number {
  return Math.floor(INVITE_CODE_MIN + Math.random() * INVITE_CODE_RANGE);
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Get (or create) the current user's invite code and usage stats.
 */
export async function getMyCode(userId: string): Promise<MyCodeResponse> {
  // Get or create user record
  let user = await repo.getUserInviteCode(userId);

  // If user doesn't exist or doesn't have an invite code, create one
  if (user === null || user.inviteCode === null || user.inviteCode === undefined) {
    let inviteCode!: number;
    let isUnique = false;

    // Keep generating until we get a unique code
    while (!isUnique) {
      inviteCode = generateInviteCode();
      const taken = await repo.isInviteCodeTaken(inviteCode);
      if (!taken) {
        isUnique = true;
      }
    }

    user = await repo.upsertUserInviteCode(userId, inviteCode);
  }

  const usesRemaining = Math.max(0, MAX_INVITE_CODE_USES - user.inviteCodeUses);

  return {
    inviteCode: user.inviteCode,
    uses: user.inviteCodeUses,
    usesRemaining,
  };
}

/**
 * Use an invite code during signup.
 */
export async function useCode(userId: string, inviteCode: number): Promise<UseCodeResponse> {
  if (!inviteCode || typeof inviteCode !== 'number') {
    throw new InvalidInviteCodeError();
  }

  // Check if user already used an invite code
  const existingUser = await repo.getUserUsedInviteCode(userId);
  if (existingUser?.usedInviteCode !== null && existingUser?.usedInviteCode !== undefined) {
    throw new AlreadyUsedInviteCodeError();
  }

  // MASTER INVITE CODE: bypasses all checks
  if (inviteCode === MASTER_INVITE_CODE) {
    await repo.recordMasterCodeUse(userId, inviteCode);
    return {
      success: true,
      message: 'Master invite code accepted',
    };
  }

  // Find the user who owns this invite code
  const inviter = await repo.findInviter(inviteCode);
  if (!inviter) {
    throw new InviteCodeNotFoundError();
  }

  // Check if the inviter has uses remaining
  if (inviter.inviteCodeUses >= MAX_INVITE_CODE_USES) {
    throw new InviteCodeExhaustedError();
  }

  // Use the invite code
  await repo.useInviteCodeTransaction(inviteCode, userId);

  return {
    success: true,
    message: 'Invite code accepted',
  };
}

/**
 * Check if the current user needs to enter an invite code.
 * Also creates user record and initializes credit on first call (OTP verification).
 */
export async function checkInviteCode(userId: string): Promise<CheckResponse> {
  const user = await repo.findOrCreateUser(userId);

  // Initialize credit only for newly created users
  if (user.isNew) {
    await createInitialCredit(userId);
  }

  return {
    needsInviteCode: false, // PUBLIC BETA - was: user.usedInviteCode === null
  };
}
