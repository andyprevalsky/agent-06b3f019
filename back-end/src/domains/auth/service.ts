/**
 * Auth Service
 *
 * Handles OTP verification with user initialization.
 * OTP is sent/verified via Twilio Verify, then Supabase user is created/found
 * and a JWT session is generated.
 */

import { createSignupBonusCredit, createInitialCredit } from '../../providers/credits';
import { sendSms, sendMms } from '../../providers/smsQueue';
import { SMS_TEMPLATES, getPersonalizedVcardUrl } from '../../providers/smsTemplates';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import type { SessionTokens, AnonymousSessionResult } from './types';
import { generateSupabaseSession, generateAnonymousSession } from './service.session';
import {
  sendTwilioVerifyOTP,
  checkTwilioVerifyOTP,
  findOrCreateSupabaseUser,
} from './service.twilio';

export { AuthConfigError } from './service.session';
export { sendTwilioVerifyOTP, checkTwilioVerifyOTP, findOrCreateSupabaseUser };

const log = createLogger('Auth');

// ---------------------------------------------------------------------------
// Resource merging
// ---------------------------------------------------------------------------

/**
 * Merge resources from anonymous user to authenticated user.
 * Transfers ownership of agents, browser context, and other user data.
 */
export async function mergeAnonymousUserResources(
  anonymousUserId: string,
  authenticatedUserId: string
) {
  try {
    const merged: string[] = [];

    const agentResult = await repo.transferAgents(anonymousUserId, authenticatedUserId);
    if (agentResult.count > 0) merged.push(`${agentResult.count} agents`);

    const blueprintResult = await repo.transferGoalBlueprints(anonymousUserId, authenticatedUserId);
    if (blueprintResult.count > 0) merged.push(`${blueprintResult.count} goal blueprints`);

    const authBrowserContext = await repo.findBrowserContext(authenticatedUserId);
    if (authBrowserContext === null) {
      const browserResult = await repo.transferBrowserContext(anonymousUserId, authenticatedUserId);
      if (browserResult.count > 0) merged.push('browser context');
    } else {
      await repo.deleteBrowserContext(anonymousUserId);
    }

    if (merged.length > 0) {
      log.info(`Merged anonymous to authenticated: ${merged.join(', ')}`, {
        anonymous_user_id: anonymousUserId,
        user_id: authenticatedUserId,
      });
    } else {
      log.info('No resources to merge from anonymous user', { anonymous_user_id: anonymousUserId });
    }
  } catch (error) {
    log.error('Failed to merge resources', {
      anonymous_user_id: anonymousUserId,
      user_id: authenticatedUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Anonymous session flow
// ---------------------------------------------------------------------------

/**
 * Create an anonymous session: generate tokens, create DB user, grant initial credit.
 */
export async function createAnonymousSession(): Promise<AnonymousSessionResult> {
  const { user, session } = generateAnonymousSession();

  await repo.createUser({
    userId: user.id,
    isAnonymous: true,
  });

  await createInitialCredit(user.id);

  log.info('Created anonymous user with $1 initial credit', { user_id: user.id });

  return { user, session };
}

// ---------------------------------------------------------------------------
// OTP send
// ---------------------------------------------------------------------------

/**
 * Send OTP to a phone number. Returns result with success/error.
 */
export async function sendOtp(phone: string): Promise<{ success: boolean; error?: string }> {
  return sendTwilioVerifyOTP(phone);
}

// ---------------------------------------------------------------------------
// OTP verify + user init helpers
// ---------------------------------------------------------------------------

/** Handle creating a new user record during OTP verification. */
async function handleNewUser(
  userId: string,
  phone: string,
  firstName: string | undefined,
  lastName: string | undefined,
  anonymousUserId: string | undefined
): Promise<void> {
  const nameParts = [firstName, lastName].filter(
    (part): part is string => part !== undefined && part !== ''
  );
  const fullName = nameParts.length > 0 ? nameParts.join(' ') : null;

  await repo.createUser({
    userId,
    phone,
    name: fullName,
    isAnonymous: false,
  });
  log.info('Created user record', {
    user_id: userId,
    phone: phone.slice(0, -4) + '****',
    name: fullName ?? undefined,
  });

  await createSignupBonusCredit(userId);
  log.info('Created signup bonus credit', { user_id: userId });

  if (anonymousUserId !== undefined && anonymousUserId !== '' && anonymousUserId !== userId) {
    await mergeAnonymousUserResources(anonymousUserId, userId);
  }
}

/** Handle updating an existing user record during OTP verification. */
async function handleExistingUser(
  existingUser: NonNullable<Awaited<ReturnType<typeof repo.findUserById>>>,
  userId: string,
  phone: string,
  firstName: string | undefined,
  lastName: string | undefined,
  anonymousUserId: string | undefined
): Promise<void> {
  const updates: { phone?: string; name?: string; isAnonymous?: boolean } = {};

  if ((existingUser.phone === null || existingUser.phone === '') && phone !== '') {
    updates.phone = phone;
  }

  if (
    (existingUser.name === null || existingUser.name === '') &&
    (firstName !== undefined || lastName !== undefined)
  ) {
    const nameParts = [firstName, lastName].filter(
      (part): part is string => part !== undefined && part !== ''
    );
    const fullName = nameParts.join(' ');
    if (fullName !== '') {
      updates.name = fullName;
    }
  }

  if (existingUser.isAnonymous) {
    updates.isAnonymous = false;
    await repo.updateUser(userId, updates);
    await createSignupBonusCredit(userId);
    log.info('Converted anonymous user to authenticated, gave signup bonus', {
      user_id: userId,
    });
  } else if (Object.keys(updates).length > 0) {
    await repo.updateUser(userId, updates);
    log.info('Updated user', { user_id: userId, updates: JSON.stringify(updates) });
  } else {
    log.info('User already exists and is authenticated', { user_id: userId });
  }

  if (anonymousUserId !== undefined && anonymousUserId !== '' && anonymousUserId !== userId) {
    await mergeAnonymousUserResources(anonymousUserId, userId);
  }
}

// ---------------------------------------------------------------------------
// OTP verify + user init
// ---------------------------------------------------------------------------

type VerifyOtpSuccess = {
  success: true;
  user: { id: string; phone: string; is_anonymous: false };
  session: SessionTokens;
};
type VerifyOtpFailure = { success: false; error: string; statusCode: number };

/**
 * Verify OTP, find/create Supabase user, create/update DB user, merge anonymous resources.
 */
export async function verifyOtpAndInitUser(params: {
  phone: string;
  token: string;
  anonymousUserId?: string;
  firstName?: string;
  lastName?: string;
}): Promise<VerifyOtpSuccess | VerifyOtpFailure> {
  const { phone, token, anonymousUserId, firstName, lastName } = params;

  const verifyResult = await checkTwilioVerifyOTP(phone, token);

  if (!verifyResult.approved) {
    log.error('OTP verification failed', {
      phone: phone.slice(0, -4) + '****',
      error: verifyResult.error,
    });
    return { success: false, error: verifyResult.error ?? 'Invalid OTP', statusCode: 400 };
  }

  const supabaseUser = await findOrCreateSupabaseUser(phone);

  if (supabaseUser === null) {
    log.error('Failed to find/create Supabase user');
    return { success: false, error: 'Failed to create user session', statusCode: 500 };
  }

  const { userId } = supabaseUser;
  const session = generateSupabaseSession(userId, phone);
  const existingUser = await repo.findUserById(userId);

  if (existingUser === null) {
    await handleNewUser(userId, phone, firstName, lastName, anonymousUserId);
  } else {
    await handleExistingUser(existingUser, userId, phone, firstName, lastName, anonymousUserId);
  }

  return {
    success: true,
    user: { id: userId, phone, is_anonymous: false },
    session,
  };
}

// ---------------------------------------------------------------------------
// Complete onboarding
// ---------------------------------------------------------------------------

/**
 * Mark onboarding as complete and send welcome SMS (mac-app flow).
 */
export async function completeOnboarding(userId: string): Promise<
  | {
      success: true;
      alreadyCompleted: boolean;
      onboardingCompletedAt: Date | null;
    }
  | {
      success: false;
      error: string;
      statusCode: number;
    }
> {
  const user = await repo.findUserById(userId);

  if (user === null) {
    return { success: false, error: 'User not found', statusCode: 404 };
  }

  if (user.onboardingCompletedAt !== null) {
    log.info('User already completed onboarding', { user_id: userId });
    return {
      success: true,
      alreadyCompleted: true,
      onboardingCompletedAt: user.onboardingCompletedAt,
    };
  }

  const updatedUser = await repo.updateUser(userId, { onboardingCompletedAt: new Date() });

  log.info('Marked onboarding complete', { user_id: userId });

  if (user.phone !== null && user.phone !== '') {
    const firstName = user.name?.split(' ')[0] ?? 'there';
    const personalizedVcardUrl = getPersonalizedVcardUrl(userId);
    const userPhone = user.phone;
    sendSms(userPhone, SMS_TEMPLATES.onboardingWelcome(firstName))
      .then(() => sendMms(userPhone, '', personalizedVcardUrl))
      .catch((error: unknown) => {
        log.error('Failed to send welcome messages', {
          user_id: userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    log.info('Sending welcome SMS + vCard', { user_id: userId });
  }

  return {
    success: true,
    alreadyCompleted: false,
    onboardingCompletedAt: updatedUser.onboardingCompletedAt,
  };
}
