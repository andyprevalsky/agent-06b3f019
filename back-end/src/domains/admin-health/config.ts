import type { AdminHealthTimeSlice } from './types';

// Only production actually contacts waitlist people. The local dev DB is seeded
// with real phone-bearing waitlist rows (see back-end/scripts/seed-local.ts),
// so an admin clicking the invite action locally must NOT fire a real SMS or
// email — dev still ungates + marks invited, it just skips the sends.
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export const ADMIN_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara Chayo
]);
// Core team seeded into the "# of Users" / subscriber-scoped metrics, resolved by
// PHONE rather than userId. Resolving by userId dropped the dev/test account
// (userId 1f85ff25…, phone +19729777432) because its row is isAnonymous=true, so
// the card read 1 instead of 3. Phone-based resolution (see findUsersByPhones,
// which intentionally ignores isAnonymous for this explicit allowlist) counts all
// three real people regardless of that flag.
export const ADMIN_HEALTH_ADDITIONAL_PHONES = new Set([
  '+19729777432', // me
  '+12028803603', // tamy
  '+17134712306', // aman
]);
export const ADMIN_HEALTH_EXCLUDED_USER_IDS = new Set<string>([]);
export const ADMIN_PHONE_DIGITS = new Set(['19729777432', '9729777432']);
export const POINTS_BY_SLICE: Record<AdminHealthTimeSlice, number> = {
  weekly: 12,
  monthly: 12,
  quarterly: 8,
  yearly: 5,
};
export const DAYS_BY_SLICE: Record<AdminHealthTimeSlice, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
};

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
export const LINEAR_API_KEY = process.env.LINEAR_API_KEY ?? '';
export const GITHUB_REPO = process.env.ADMIN_HEALTH_GITHUB_REPO ?? 'Rose-Ai-Labs/rose';
export const LINEAR_ANDY_NAMES = ['Andy Prevalsky', 'Andy'];
export const LINEAR_TAMARA_NAMES = ['Tamara Chayo', 'Tamy Chayo', 'Tamy', 'Tamara', 'tamarachayo'];
export const AMPLITUDE_API_KEY = process.env.AMPLITUDE_API_KEY ?? '';
export const AMPLITUDE_SECRET_KEY = process.env.AMPLITUDE_SECRET_KEY ?? '';
export const AMPLITUDE_API_BASE_URL = process.env.AMPLITUDE_API_BASE_URL ?? 'https://amplitude.com';
export const BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES =
  process.env.BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES;
export const BLACKBOX_TEST_CAPTURE_OUTBOUND = process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND === '1';
/**
 * Canonical copy sent by both SMS and email when an admin pulls someone off
 * the waitlist. Keeping one value prevents the two channels from drifting.
 */
export const WAITLIST_INVITE_COPY =
  'Welcome to Rose. You are one of the first people in the world to access super intelligence. ' +
  'To finish setting up your account, download our Mac application at https://roselabs.ai/download ' +
  'and follow the steps';
export const WAITLIST_INVITE_EMAIL_SUBJECT = 'Welcome to Rose - finish setting up your account';
export const WAITLIST_INVITE_EMAIL_SENDER_USER_ID =
  process.env.WAITLIST_INVITE_EMAIL_SENDER_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';
export const WAITLIST_INVITE_EMAIL_FROM = process.env.WAITLIST_INVITE_EMAIL_FROM ?? 'a@roselabs.ai';
export const WAITLIST_INVITE_EMAIL_FROM_NAME = 'Rose';

export const STRIPE_REVENUE_EXCLUDED_CHARGE_IDS = new Set(
  (process.env.ADMIN_HEALTH_STRIPE_EXCLUDED_CHARGE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
