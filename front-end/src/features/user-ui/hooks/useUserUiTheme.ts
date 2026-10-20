/**
 * Fetches the active version's theme.json and applies its tokens.
 *
 *   no theme / safe mode → nothing applied (previous tokens removed)
 *   theme loaded         → valid `--name: value` tokens set on <html>;
 *                          invalid names/values are dropped (tokens are data)
 *   version change       → old tokens removed before the new ones apply
 */
import { useEffect, useState } from 'react';

import { fetchUserUiTheme } from '../api';
import { joinUserContentUrl, validateThemeTokens } from '../config';
import type { ActiveUserUi, UserUiTheme } from '../types';

/** Apply validated tokens to <html>; returns a cleanup that removes them. */
export function applyThemeTokens(
  tokens: unknown,
  root: HTMLElement = document.documentElement,
): () => void {
  const { accepted, rejected } = validateThemeTokens(tokens);
  if (rejected.length > 0) console.warn('[UserUi] rejected theme tokens', rejected);
  const names = Object.keys(accepted);
  for (const name of names) root.style.setProperty(name, accepted[name]);
  return () => {
    for (const name of names) root.style.removeProperty(name);
  };
}

function useThemeDocument(active: ActiveUserUi | null): UserUiTheme | null {
  const [theme, setTheme] = useState<UserUiTheme | null>(null);
  const themeUrl =
    active?.manifest.theme !== undefined
      ? joinUserContentUrl(active.baseUrl, active.manifest.theme)
      : null;

  useEffect(() => {
    setTheme(null);
    if (!themeUrl) return;
    let cancelled = false;
    fetchUserUiTheme(themeUrl)
      .then((loaded) => {
        if (!cancelled) setTheme(loaded);
      })
      .catch((error: unknown) => console.warn('[UserUi] theme load failed', error));
    return () => {
      cancelled = true;
    };
  }, [themeUrl]);

  return theme;
}

export function useUserUiTheme(active: ActiveUserUi | null, safeMode: boolean) {
  const theme = useThemeDocument(active);

  useEffect(() => {
    if (safeMode || !theme?.tokens) return;
    return applyThemeTokens(theme.tokens);
  }, [theme, safeMode]);

  return safeMode ? null : theme;
}
