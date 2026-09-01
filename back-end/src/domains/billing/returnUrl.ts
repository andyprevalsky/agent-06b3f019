import { createHash } from 'node:crypto';

import { PRODUCTION_WEB_ORIGINS } from '../../providers/corsConfig';

import { isProductionRuntime } from './config';

const DEFAULT_RETURN_URL_PRODUCTION = 'https://roselabs.ai/settings';
const DEFAULT_RETURN_URL_LOCAL = 'http://localhost:5173/settings';

function defaultReturnUrl(): string {
  return isProductionRuntime() ? DEFAULT_RETURN_URL_PRODUCTION : DEFAULT_RETURN_URL_LOCAL;
}

function isAllowedReturnOrigin(origin: string): boolean {
  if (PRODUCTION_WEB_ORIGINS.includes(origin as (typeof PRODUCTION_WEB_ORIGINS)[number])) {
    return true;
  }

  if (!isProductionRuntime()) {
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      return true;
    }
    if (origin.endsWith('.vercel.app')) {
      return true;
    }
  }

  return false;
}

/** Validate and normalize a caller-supplied post-checkout return URL. */
export function resolveSubscriptionReturnUrl(returnUrl: string | undefined | null): string {
  if (returnUrl === undefined || returnUrl === null || returnUrl.trim() === '') {
    return defaultReturnUrl();
  }

  let parsed: URL;
  try {
    parsed = new URL(returnUrl.trim());
  } catch {
    return defaultReturnUrl();
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return defaultReturnUrl();
  }

  if (!isAllowedReturnOrigin(parsed.origin)) {
    return defaultReturnUrl();
  }

  // Drop any existing subscription callback params so we can append fresh ones.
  parsed.searchParams.delete('subscription');
  return parsed.toString();
}

export function buildSubscriptionCallbackUrls(baseReturnUrl: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const success = new URL(baseReturnUrl);
  success.searchParams.set('subscription', 'success');

  const cancel = new URL(baseReturnUrl);
  cancel.searchParams.set('subscription', 'cancelled');

  return { successUrl: success.toString(), cancelUrl: cancel.toString() };
}

export function subscriptionCheckoutIdempotencyKey(
  userId: string,
  livemode: boolean,
  returnUrl: string
): string {
  const mode = livemode ? 'live' : 'test';
  const hash = createHash('sha256').update(returnUrl).digest('hex').slice(0, 16);
  return `subscription-checkout:${mode}:${userId}:${hash}`;
}
