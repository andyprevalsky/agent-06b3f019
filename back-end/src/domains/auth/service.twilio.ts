import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VERIFY_SERVICE_SID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  IS_DEV,
} from './config';
import type { TwilioVerifyResponse, SupabaseAdminUserResponse } from './types';

// Dev-mode test credentials: bypass Twilio for fast local login
// Disabled when BLACKBOX_TEST_CAPTURE_OUTBOUND is set (tests need real Twilio calls)
const DEV_TEST_PHONE = '+19729777432';
const DEV_TEST_OTP = '181818';
const isBlackboxTest = process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND === '1';

const log = createLogger('Auth');

/**
 * Send OTP via Twilio Verify
 */
export async function sendTwilioVerifyOTP(
  phone: string
): Promise<{ success: boolean; error?: string }> {
  // Dev bypass: skip Twilio for test phone (disabled in blackbox tests)
  if (IS_DEV && !isBlackboxTest && phone === DEV_TEST_PHONE) {
    log.info('Dev bypass: skipping Twilio send for test phone');
    return { success: true };
  }

  /* c8 ignore next 10 -- config validation: env vars always set in test environment */
  if (
    TWILIO_ACCOUNT_SID === undefined ||
    TWILIO_ACCOUNT_SID === '' ||
    TWILIO_AUTH_TOKEN === undefined ||
    TWILIO_AUTH_TOKEN === '' ||
    TWILIO_VERIFY_SERVICE_SID === undefined ||
    TWILIO_VERIFY_SERVICE_SID === ''
  ) {
    log.error('Missing Twilio Verify configuration');
    return { success: false, error: 'Server configuration error' };
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Channel: 'sms' }),
    });

    const data = (await response.json()) as TwilioVerifyResponse;

    if (!response.ok) {
      log.error('Twilio Verify send error', {
        status: response.status,
        code: data.code,
        twilio_message: data.message,
        phone: phone.slice(0, -4) + '****',
      });
      return { success: false, error: data.message ?? 'Failed to send OTP' };
    }

    log.info('Twilio Verify OTP sent', {
      sid: data.sid,
      status: data.status,
      phone: phone.slice(0, -4) + '****',
    });

    return { success: true };
  } catch (error) {
    log.error('Twilio Verify send exception', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, error: 'Failed to send OTP' };
  }
}

/**
 * Check OTP via Twilio Verify
 */
export async function checkTwilioVerifyOTP(
  phone: string,
  code: string
): Promise<{ approved: boolean; error?: string }> {
  // Dev bypass: auto-approve test phone + test OTP (disabled in blackbox tests)
  if (IS_DEV && !isBlackboxTest && phone === DEV_TEST_PHONE && code === DEV_TEST_OTP) {
    log.info('Dev bypass: auto-approving test OTP');
    return { approved: true };
  }

  /* c8 ignore next 10 -- config validation: env vars always set in test environment */
  if (
    TWILIO_ACCOUNT_SID === undefined ||
    TWILIO_ACCOUNT_SID === '' ||
    TWILIO_AUTH_TOKEN === undefined ||
    TWILIO_AUTH_TOKEN === '' ||
    TWILIO_VERIFY_SERVICE_SID === undefined ||
    TWILIO_VERIFY_SERVICE_SID === ''
  ) {
    log.error('Missing Twilio Verify configuration');
    return { approved: false, error: 'Server configuration error' };
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Code: code }),
    });

    const data = (await response.json()) as TwilioVerifyResponse;

    if (!response.ok) {
      log.error('Twilio Verify check error', {
        status: response.status,
        code: data.code,
        twilio_message: data.message,
        phone: phone.slice(0, -4) + '****',
      });

      let errorMessage = 'Invalid code';
      if (response.status === 404 || data.code === 20404) {
        errorMessage = 'Code expired. Please request a new one.';
      } else if (data.code === 60202) {
        errorMessage = 'Too many attempts. Please request a new code.';
      }

      return { approved: false, error: errorMessage };
    }

    const approved = data.status === 'approved';
    log.info('Twilio Verify check result', {
      status: data.status,
      valid: data.valid,
      approved,
      phone: phone.slice(0, -4) + '****',
    });

    return { approved, error: approved ? undefined : 'Invalid OTP' };
  } catch (error) {
    log.error('Twilio Verify check exception', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { approved: false, error: 'Failed to verify OTP' };
  }
}

/**
 * Find or create Supabase user by phone.
 * First checks our own DB (fast, reliable), then falls back to Supabase Admin API for new users.
 */
export async function findOrCreateSupabaseUser(
  phone: string
): Promise<{ userId: string; isNew: boolean } | null> {
  /* c8 ignore next 8 -- config validation: env vars always set in test environment */
  if (
    SUPABASE_URL === undefined ||
    SUPABASE_URL === '' ||
    SUPABASE_SERVICE_ROLE_KEY === undefined ||
    SUPABASE_SERVICE_ROLE_KEY === ''
  ) {
    log.error('Missing Supabase configuration');
    return null;
  }

  try {
    const existingDbUser = await repo.findUserByPhone(phone);

    if (existingDbUser !== null) {
      log.info('Found existing user in our DB', {
        user_id: existingDbUser.userId,
        phone: phone.slice(0, -4) + '****',
      });
      return { userId: existingDbUser.userId, isNew: false };
    }

    log.info('User not in our DB, creating in Supabase...');
    const createUrl = `${SUPABASE_URL}/auth/v1/admin/users`;
    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone, phone_confirm: true }),
    });

    const createData = await createResponse.json();

    if (createResponse.ok) {
      const newUser = createData as SupabaseAdminUserResponse;
      log.info('Created new Supabase user', {
        user_id: newUser.id,
        phone: phone.slice(0, -4) + '****',
      });
      return { userId: newUser.id, isNew: true };
    }

    const errorData = createData as { error_code?: string; msg?: string };
    log.error('Supabase create failed', {
      status: createResponse.status,
      error_code: errorData.error_code,
      msg: errorData.msg,
    });

    if (createResponse.status === 422 && errorData.error_code === 'phone_exists') {
      log.error('User exists in Supabase but not in our DB', {
        phone: phone.slice(0, -4) + '****',
      });
    }

    return null;
  } catch (error) {
    log.error('Supabase user lookup/create exception', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
