/**
 * Fetches the active version's theme.json and applies its tokens.
 *
 *   no theme / safe mode → nothing applied (previous tokens removed)
 *   theme loaded         → valid `--name: value` tokens set on <html>;
 *                          invalid names/values are dropped (tokens are data)
 *   version change       → the previous theme (tokens + background, resolved
 *                          against ITS version's baseUrl) stays until the new
 *                          theme.json loads, then swaps in place — no flash
 *                          to the stock UI during a live publish
 *   new version has no theme / its theme fails → cleared (stock tokens)
 */
import { useEffect, useState } from 'react';

import { fetchUserUiTheme } from '../api';
import { joinUserContentUrl, validateThemeTokens } from '../config';
import type { ActiveUserUi, UserUiTheme } from '../types';

/** A loaded theme.json plus the version base URL its relative paths resolve to. */
export interface LoadedUserUiTheme {
  theme: UserUiTheme;
  baseUrl: string;
}

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

function useThemeDocument(active: ActiveUserUi | null): LoadedUserUiTheme | null {
  const [loaded, setLoaded] = useState<LoadedUserUiTheme | null>(null);
  const baseUrl = active?.baseUrl ?? null;
  const themeUrl =
    active?.manifest.theme !== undefined
      ? joinUserContentUrl(active.baseUrl, active.manifest.theme)
      : null;

  useEffect(() => {
    if (!themeUrl || !baseUrl) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    fetchUserUiTheme(themeUrl)
      .then((theme) => {
        if (!cancelled) setLoaded({ theme, baseUrl });
      })
      .catch((error: unknown) => {
        console.warn('[UserUi] theme load failed', error);
        if (!cancelled) setLoaded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [themeUrl, baseUrl]);

  return loaded;
}

export function useUserUiTheme(
  active: ActiveUserUi | null,
  safeMode: boolean,
): LoadedUserUiTheme | null {
  const loaded = useThemeDocument(active);
  const tokens = loaded?.theme.tokens;

  useEffect(() => {
    if (safeMode || !tokens) return;
    return applyThemeTokens(tokens);
  }, [tokens, safeMode]);

  return safeMode ? null : loaded;
}
