/**
 * Memoized access to the test-prompt catalog.
 *
 * The backend adapts `agents/benchmarks/tasks.json` (the single canonical eval
 * catalog) into picker shape via GET /api/benchmarks/test-prompts, so the dev
 * query box and the benchmark suite can never drift apart. The HTTP call lives
 * in the feature's api.ts layer (`fetchTestPromptCatalog`).
 *
 * The fetch is memoized module-level: TestPromptsSelector and
 * useAutoLoadDefaultPrompt share one request per app lifetime.
 */

import { fetchTestPromptCatalog } from '../../hooks';
import type { TestPrompt } from './types';

/** Dev default prompt — auto-loaded into QueryInput on mount in dev mode. */
export const DEV_DEFAULT_PROMPT_TITLE = 'Basic Chat Response';

let cachedPromptsPromise: Promise<TestPrompt[]> | null = null;

export async function fetchTestPrompts(): Promise<TestPrompt[]> {
  if (!cachedPromptsPromise) {
    cachedPromptsPromise = fetchTestPromptCatalog().catch((error: unknown) => {
      // Reset so a transient backend hiccup doesn't permanently empty the picker.
      cachedPromptsPromise = null;
      throw error;
    });
  }
  return cachedPromptsPromise;
}

/** Test-only: clears the memoized catalog so each test controls its own fetch. */
export function resetTestPromptsCache(): void {
  cachedPromptsPromise = null;
}
