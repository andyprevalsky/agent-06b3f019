import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VERIFY_SERVICE_SID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  IS_DEV,
  IS_BLACKBOX_TEST,
  BENCHMARK_ALLOW_DEV_OTP_LOGIN,
} from './config';
import type { TwilioVerifyResponse, SupabaseAdminUserResponse } from './types';

// Dev-mode test credentials: bypass Twilio for fast local login
// Disabled when BLACKBOX_TEST_CAPTURE_OUTBOUND is set (tests need real Twilio calls)
// The +52 variant exercises the LATAM country-selector path without a real MX SMS.
const DEV_TEST_PHONES = ['+19729777432', '+529729777432'];
const DEV_TEST_OTP = '181818';

// Review credentials: bypass Twilio in all environments so external reviewers
// can use fixed evaluation credentials without receiving a real SMS.
const BROWSER_REVIEW_TEST_PHONE = '+15555550123';
const BROWSER_REVIEW_TEST_OTP = '191919';

/**
 * Whether the dev test-phone OTP bypass applies. Pure + exported for unit tests.
 *
 * The `isDev` gate makes this impossible in production (NODE_ENV=production →
 * IS_DEV=false), so it can never weaken real auth. Benchmark stacks set
 * BLACKBOX_TEST_CAPTURE_OUTBOUND=1 to capture the agent's outbound SMS, which
 * flips `isBlackboxTest` and would otherwise disable the bypass — but the
 * message-person benchmark's iMessage relay needs it to auto-login the benchmark
 * user. `benchmarkAllowDevOtpLogin` (run.sh's BENCHMARK_ALLOW_DEV_OTP_LOGIN=1)
 * re-enables the login bypass while capture stays on. Normal blackbox runs don't
 * set that flag, so their real-Twilio expectation is unchanged.
 */
export function devTestPhoneBypassApplies(
  phone: string,
  opts: { isDev: boolean; isBlackboxTest: boolean; benchmarkAllowDevOtpLogin: boolean }
): boolean {
  const blockedByBlackbox = opts.isBlackboxTest && !opts.benchmarkAllowDevOtpLogin;
  return opts.isDev && !blockedByBlackbox && DEV_TEST_PHONES.includes(phone);
}

function isDevTestPhone(phone: string): boolean {
  return devTestPhoneBypassApplies(phone, {
    isDev: IS_DEV,
    isBlackboxTest: IS_BLACKBOX_TEST,
    benchmarkAllowDevOtpLogin: BENCHMARK_ALLOW_DEV_OTP_LOGIN,
  });
}

function shouldBypassOtpSend(phone: string): boolean {
  return phone === BROWSER_REVIEW_TEST_PHONE || isDevTestPhone(phone);
}

function shouldBypassOtpCheck(phone: string, code: string): boolean {
  return (
    (phone === BROWSER_REVIEW_TEST_PHONE && code === BROWSER_REVIEW_TEST_OTP) ||
    (isDevTestPhone(phone) && code === DEV_TEST_OTP)
  );
}

const log = createLogger('Auth');

const SUPABASE_ADMIN_USERS_PAGE_SIZE = 1000;
const SUPABASE_ADMIN_USERS_MAX_PAGES = 20;

function normalizePhoneForComparison(phone: string | null | undefined): string {
  return (phone ?? '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
}

async function findExistingSupabaseUserByPhone(
  phone: string,
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<SupabaseAdminUserResponse | null> {
  const targetPhone = normalizePhoneForComparison(phone);
  if (targetPhone === '') return null;

  for (let page = 1; page <= SUPABASE_ADMIN_USERS_MAX_PAGES; page++) {
    const listUrl = new URL(`${supabaseUrl}/auth/v1/admin/users`);
    listUrl.searchParams.set('page', String(page));
    listUrl.searchParams.set('per_page', String(SUPABASE_ADMIN_USERS_PAGE_SIZE));

    const listResponse = await fetch(listUrl.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'Content-Type': 'application/json',
      },
    });

    const listData = (await listResponse.json()) as {
      users?: SupabaseAdminUserResponse[];
      error_code?: string;
      msg?: string;
    };

    if (!listResponse.ok) {
      log.error('Supabase user lookup failed after phone_exists', {
        status: listResponse.status,
        error_code: listData.error_code,
        msg: listData.msg,
      });
      return null;
    }

    const users = Array.isArray(listData.users) ? listData.users : [];
    const match = users.find((user) => normalizePhoneForComparison(user.phone) === targetPhone);
    if (match !== undefined) return match;

    if (users.length < SUPABASE_ADMIN_USERS_PAGE_SIZE) break;
  }

  return null;
}

/**
 * Send OTP via Twilio Verify
 */
export async function sendTwilioVerifyOTP(
  phone: string
): Promise<{ success: boolean; error?: string }> {
  // Bypass Twilio only for fixed internal/review evaluation credentials.
  if (shouldBypassOtpSend(phone)) {
    log.info('OTP bypass: skipping Twilio send for test phone');
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
  // Bypass Twilio only for fixed internal/review evaluation credentials.
  if (shouldBypassOtpCheck(phone, code)) {
    log.info('OTP bypass: auto-approving test OTP');
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

  const supabaseUrl = SUPABASE_URL;
  const serviceRoleKey = SUPABASE_SERVICE_ROLE_KEY;

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
    const createUrl = `${supabaseUrl}/auth/v1/admin/users`;
    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
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
      log.info('User exists in Supabase but not in our DB; resolving existing auth user', {
        phone: phone.slice(0, -4) + '****',
      });
      const existingSupabaseUser = await findExistingSupabaseUserByPhone(
        phone,
        supabaseUrl,
        serviceRoleKey
      );
      if (existingSupabaseUser !== null) {
        log.info('Resolved existing Supabase user after phone_exists', {
          user_id: existingSupabaseUser.id,
          phone: phone.slice(0, -4) + '****',
        });
        return { userId: existingSupabaseUser.id, isNew: false };
      }

      log.error('User exists in Supabase but could not be resolved by phone', {
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
