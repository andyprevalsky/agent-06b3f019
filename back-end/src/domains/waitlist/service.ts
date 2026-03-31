import * as repo from './repo';
import type { JoinWaitlistInput, JoinWaitlistResult } from './types';

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export async function joinWaitlist(input: JoinWaitlistInput): Promise<JoinWaitlistResult> {
  // Validate inputs
  if (
    typeof input.name !== 'string' ||
    input.name === '' ||
    typeof input.email !== 'string' ||
    input.email === ''
  ) {
    throw new ValidationError('Name and email are required');
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(input.email)) {
    throw new ValidationError('Invalid email format');
  }

  try {
    await repo.createEntry({
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      variant: input.variant ?? null,
    });

    return {
      success: true,
      message: "You're on the waitlist!",
      alreadyRegistered: false,
    };
  } catch (dbError: unknown) {
    // Handle duplicate email (unique constraint violation)
    if (
      dbError instanceof Error &&
      'code' in dbError &&
      (dbError as { code: string }).code === 'P2002'
    ) {
      return {
        success: true,
        message: "You're already on the waitlist!",
        alreadyRegistered: true,
      };
    }
    throw dbError;
  }
}
