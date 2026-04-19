/**
 * Auto-loads the DEV_DEFAULT_PROMPT_TITLE prompt into QueryInput on mount.
 *
 * Runs once per app lifetime (tracked via a module-level flag so React 18
 * StrictMode double-mounts don't fire the callback twice). Skipped outside
 * dev mode, and skipped inside Vitest — vitest sets `DEV=true` but we don't
 * want to populate inputs in tests.
 */

import { useEffect } from 'react';
import { IS_DEV_MODE, IS_VITEST } from '../../config';
import { fetchTestPromptFiles } from './fetchTestPromptFiles';
import { DEV_DEFAULT_PROMPT_TITLE, TEST_PROMPTS } from './prompts';

let hasAutoLoaded = false;

type OnSelectPrompt = (prompt: string, files?: File[]) => void;

export function useAutoLoadDefaultPrompt(onSelectPrompt: OnSelectPrompt): void {
  useEffect(() => {
    if (IS_VITEST || !IS_DEV_MODE || hasAutoLoaded) return;
    hasAutoLoaded = true;

    const defaultPrompt = TEST_PROMPTS.find((p) => p.title === DEV_DEFAULT_PROMPT_TITLE);
    if (!defaultPrompt) return;

    void (async () => {
      try {
        const files = defaultPrompt.attachmentUrls
          ? await fetchTestPromptFiles(defaultPrompt.attachmentUrls)
          : undefined;
        onSelectPrompt(defaultPrompt.prompt, files);
      } catch {
        onSelectPrompt(defaultPrompt.prompt);
      }
    })();
  }, [onSelectPrompt]);
}
