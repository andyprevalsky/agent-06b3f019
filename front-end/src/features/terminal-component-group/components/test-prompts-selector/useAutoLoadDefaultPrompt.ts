/**
 * Auto-loads the DEV_DEFAULT_PROMPT_TITLE prompt into QueryInput on mount.
 *
 * Runs once per app lifetime (tracked via a module-level flag so React 18
 * StrictMode double-mounts don't fire the callback twice). Skipped outside
 * dev mode, skipped inside Vitest — vitest sets `DEV=true` but we don't
 * want to populate inputs in tests — and skipped in WebDriver-driven
 * sessions (Playwright sets `navigator.webdriver`): automated tests type
 * their own goals, and the late-resolving catalog request can race the
 * test's fill() and replace the goal it typed, so the browser submits the
 * default benchmark prompt instead (observed in the chat-lifecycle-latency
 * semantic gate, where the mass-creators default was submitted instead of
 * the execute-forcing prompt and the router — correctly for that goal —
 * escalated to plan, so the execute-phase bubble never rendered).
 *
 * Prompts come from the unified eval catalog via fetchTestPrompts (shared
 * memoized request with TestPromptsSelector).
 */

import { useEffect, useRef } from 'react';
import { IS_DEV_MODE, IS_VITEST } from '../../config';
import { fetchTestPromptFiles } from './fetchTestPromptFiles';
import { DEV_DEFAULT_PROMPT_TITLE, fetchTestPrompts } from './fetchTestPrompts';

let hasAutoLoaded = false;

/** Test-only: allows isolated tests to re-run the once-per-app auto-load. */
export function resetAutoLoadDefaultPromptForTests(): void {
  hasAutoLoaded = false;
}

type OnSelectPrompt = (prompt: string, files?: File[]) => void;

const ALWAYS_AUTO_LOAD = () => true;

export function useAutoLoadDefaultPrompt(
  onSelectPrompt: OnSelectPrompt,
  shouldAutoLoadDefaultPrompt: () => boolean = ALWAYS_AUTO_LOAD,
): void {
  const onSelectPromptRef = useRef(onSelectPrompt);
  const shouldAutoLoadDefaultPromptRef = useRef(shouldAutoLoadDefaultPrompt);
  onSelectPromptRef.current = onSelectPrompt;
  shouldAutoLoadDefaultPromptRef.current = shouldAutoLoadDefaultPrompt;

  useEffect(() => {
    if (IS_VITEST || !IS_DEV_MODE || hasAutoLoaded) return;
    // Automation (Playwright/WebDriver) never benefits from the dev
    // convenience seed and can lose typed input to it — see header comment.
    if (typeof navigator !== 'undefined' && navigator.webdriver) return;
    hasAutoLoaded = true;

    void (async () => {
      let defaultPrompt;
      try {
        const prompts = await fetchTestPrompts();
        defaultPrompt = prompts.find((p) => p.title === DEV_DEFAULT_PROMPT_TITLE);
      } catch {
        return;
      }
      if (!defaultPrompt) return;
      if (!shouldAutoLoadDefaultPromptRef.current()) return;

      try {
        const files =
          defaultPrompt.attachmentUrls && defaultPrompt.attachmentUrls.length > 0
            ? await fetchTestPromptFiles(defaultPrompt.attachmentUrls)
            : undefined;
        if (shouldAutoLoadDefaultPromptRef.current()) {
          onSelectPromptRef.current(defaultPrompt.prompt, files);
        }
      } catch {
        if (shouldAutoLoadDefaultPromptRef.current()) {
          onSelectPromptRef.current(defaultPrompt.prompt);
        }
      }
    })();
  }, []);
}
