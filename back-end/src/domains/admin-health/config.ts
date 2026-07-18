import type { AdminHealthTimeSlice } from './types';

// Only production actually texts waitlist people. The local dev DB is seeded
// with real phone-bearing waitlist rows (see back-end/scripts/seed-local.ts),
// so an admin clicking "Invite & text" locally must NOT fire a real SMS to a
// stranger — dev still ungates + marks invited, it just skips the send.
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export const ADMIN_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara Chayo
]);
export const ADMIN_HEALTH_ADDITIONAL_USER_IDS = new Set([
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara Chayo; Andy is intentionally excluded.
]);
export const ADMIN_HEALTH_EXCLUDED_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky; internal usage would skew metrics.
]);
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
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
export const GITHUB_REPO = process.env.ADMIN_HEALTH_GITHUB_REPO ?? 'Rose-Ai-Labs/rose';
export const LINEAR_ANDY_NAMES = ['Andy Prevalsky', 'Andy'];
export const LINEAR_TAMARA_NAMES = ['Tamara Chayo', 'Tamy Chayo', 'Tamy', 'Tamara', 'tamarachayo'];
export const AMPLITUDE_API_KEY = process.env.AMPLITUDE_API_KEY ?? '';
export const AMPLITUDE_SECRET_KEY = process.env.AMPLITUDE_SECRET_KEY ?? '';
export const AMPLITUDE_API_BASE_URL = process.env.AMPLITUDE_API_BASE_URL ?? 'https://amplitude.com';
/**
 * SMS texted to a waitlist person when an admin pulls them off the waitlist.
 * Points at the Mac app download; the invite itself clears the gate server-side
 * so no code is needed once they sign in.
 */
export const WAITLIST_INVITE_SMS =
  'Welcome to Rose. You are one of the first people in the world to access super intelligence. ' +
  'To finish setting up your account, download our Mac application at https://roselabs.ai/download ' +
  'and follow the steps';

export const STRIPE_REVENUE_EXCLUDED_CHARGE_IDS = new Set(
  (process.env.ADMIN_HEALTH_STRIPE_EXCLUDED_CHARGE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
