/**
 * Cost domain repo: external data access (OpenRouter catalog fetch).
 *
 * Layer: repo
 * May import from: own types, own config.
 */

import {
  getHttpReferer,
  getOpenRouterApiKey,
  OPENROUTER_MODELS_URL,
  OPENROUTER_TIMEOUT_MS,
  OPENROUTER_X_TITLE,
} from './config.ts';
import type { OpenRouterModel } from './types.ts';

/** Fetch implementation used by this repo. Injected so tests can stub it. */
export type FetchFn = typeof fetch;

/**
 * Fetch the OpenRouter model catalog. Aborts after OPENROUTER_TIMEOUT_MS.
 * `fetchFn` defaults to `globalThis.fetch`; tests substitute a fake.
 */
export async function fetchOpenRouterModels(
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<OpenRouterModel[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      headers: {
        'Authorization': `Bearer ${getOpenRouterApiKey()}`,
        'HTTP-Referer': getHttpReferer(),
        'X-Title': OPENROUTER_X_TITLE,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenRouter API returned ${response.status}`);
    }
    const data = (await response.json()) as { data?: OpenRouterModel[] };
    return data.data ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}
