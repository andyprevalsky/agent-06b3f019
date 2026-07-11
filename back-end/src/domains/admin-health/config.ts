import type { AdminHealthTimeSlice } from './types';

export const ADMIN_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara Chayo
]);
export const ADMIN_PHONE_DIGITS = new Set(['19729777432', '9729777432']);
export const POINTS_BY_SLICE: Record<AdminHealthTimeSlice, number> = {
  weekly: 12,
  monthly: 12,
  quarterly: 8,
  yearly: 5,
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
export const STRIPE_REVENUE_EXCLUDED_CHARGE_IDS = new Set(
  (process.env.ADMIN_HEALTH_STRIPE_EXCLUDED_CHARGE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
