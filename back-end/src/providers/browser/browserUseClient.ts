import { BrowserProviderRateLimitError } from './types';

const DEFAULT_API_URL = 'https://api.browser-use.com/api/v4';
const REQUEST_TIMEOUT_MS = 15_000;
function apiKey(): string {
  const key = process.env.BROWSER_USE_API_KEY?.trim();
  if (!key) throw new Error('BROWSER_USE_API_KEY is required for Browser Use sessions');
  return key;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const base = (process.env.BROWSER_USE_API_BASE_URL ?? DEFAULT_API_URL).replace(/\/$/, '');
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'X-Browser-Use-API-Key': apiKey(),
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      // Carry the status so callers can tell a definite rejection from an
      // uncertain outcome, like the Kernel and Steel SDK errors do.
      if (response.status === 429) {
        throw Object.assign(
          new BrowserProviderRateLimitError('browser-use', `Browser Use HTTP 429: ${detail}`),
          { status: response.status }
        );
      }
      throw Object.assign(new Error(`Browser Use HTTP ${response.status}: ${detail}`), {
        status: response.status,
      });
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  } finally {
    clearTimeout(timeout);
  }
}
