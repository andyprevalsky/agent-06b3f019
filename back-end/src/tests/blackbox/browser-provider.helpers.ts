import type { Page } from 'playwright';
import { retryWithBackoff } from '../../providers/retry';

export function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function isTransientKernelConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeText =
    cause instanceof Error
      ? `${cause.message} ${cause.name}`
      : cause !== null && typeof cause === 'object'
        ? `${String((cause as { message?: unknown }).message ?? '')} ${String(
            (cause as { code?: unknown }).code ?? ''
          )}`
        : String(cause ?? '');
  const transportError = `${message} ${causeText}`;
  return (
    message.includes('proxy connection failed') ||
    message.includes('context deadline exceeded') ||
    message.includes('Client.Timeout exceeded') ||
    // Steel create/replace flakes under parallel coverage load (SDK "Connection error").
    message.includes('Failed to create Steel replacement') ||
    message.includes('Connection error') ||
    transportError.includes('fetch failed') ||
    transportError.includes('other side closed') ||
    transportError.includes('socket hang up') ||
    transportError.includes('ECONNRESET') ||
    transportError.includes('ECONNREFUSED') ||
    transportError.includes('UND_ERR')
  );
}

/** Retry localhost transport resets without weakening HTTP response assertions. */
export function retryBackendFetch(url: string, init?: RequestInit): Promise<Response> {
  return retryWithBackoff(() => fetch(url, init), {
    maxRetries: 4,
    fixedDelays: [250, 500, 750],
    isRetryable: isTransientKernelConnectionError,
    component: 'browser-provider:backend-fetch',
  });
}

export function isRetryableKernelNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'Timeout 30000ms exceeded',
  ].some((fragment) => message.includes(fragment));
}

export async function navigateKernelPage(page: Page, url: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    } catch (error) {
      if (attempt === 3 || !isRetryableKernelNavigationError(error)) throw error;
      await page.waitForTimeout(attempt * 1_000);
    }
  }
}

export interface BrowserMetadataResponse {
  provider?: string;
  proxy_source?: string;
  proxy_location?: { country?: string; state?: string; city?: string };
  profile_id?: string;
  steel_profile_id?: string;
}

export interface BrowserApiResponse {
  session_id?: string;
  task_id?: string;
  debug_url?: string;
  ws_url?: string;
  saved_url?: string;
  provider?: string;
  path?: string;
  base64_image?: string;
  same_session_available?: boolean;
  resized?: boolean;
  viewport?: { width?: number; height?: number };
  browser_session_metadata?: BrowserMetadataResponse;
  // rotate_ip response fields
  proxy_tier?: string;
  rotations_used?: number;
  rotations_remaining?: number;
  rotation_message?: string;
  previous_provider?: string;
  recovery_action?: string;
  next_recovery?: string;
}

export function withProvider(value: string | undefined, test: () => void): void {
  const previous = process.env.BROWSER_PROVIDER;
  if (value === undefined) delete process.env.BROWSER_PROVIDER;
  else process.env.BROWSER_PROVIDER = value;
  try {
    test();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previous;
  }
}
