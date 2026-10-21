/**
 * STATE MACHINE: RoseTheme (Rose Desktop dark mode; provider in
 * components/RoseThemeProvider.tsx)
 *
 *   [STOCK]  no provider, not a Rose Desktop account, or signed out
 *            → isDark false, toggle() is a no-op, <html> is never touched
 *   [LIGHT]  default for a Rose Desktop account (nothing stored, or 'light')
 *            --toggle()--> [DARK]
 *   [DARK]   stored 'dark' --toggle()--> [LIGHT]
 *
 *   DARK  → <html class="dark"> while mounted (Tailwind darkMode: ['class']);
 *           the background layers swap to their calm dark variant
 *   LIGHT → <html> and every themed component render exactly as stock
 *           (Andy: dark mode must never change light mode in any way)
 *
 * Persisted per user in localStorage['rose-theme:<userId>'] = 'dark' | 'light'.
 * There is no options panel: dark mode is just the top-right moon/sun button
 * calling toggle().
 *
 * SYSTEM CONTEXT:
 *   top-right moon/sun --toggle()--> RoseThemeProvider --html.dark--> CSS
 *                                         └--isDark--> BackgroundPattern,
 *                                                      GridEnergyPills,
 *                                                      TerminalHeader pill
 */

import { createContext, useContext } from 'react';

import { getItem, setItem } from '@/lib/storage';

import { roseThemeStorageKey } from './config';
import type { RoseThemeChoice, RoseThemeValue } from './types';

const STOCK_THEME: RoseThemeValue = { isDark: false, toggle: () => {} };

export const RoseThemeContext = createContext<RoseThemeValue>(STOCK_THEME);

/** The current theme; outside a RoseThemeProvider always light with a no-op toggle. */
export function useRoseTheme(): RoseThemeValue {
  return useContext(RoseThemeContext);
}

export function readStoredRoseChoice(userId: string | null): RoseThemeChoice | null {
  if (userId === null) return null;
  const stored = getItem(roseThemeStorageKey(userId));
  if (stored === 'dark' || stored === 'light') return stored;
  try {
    const key = encodeURIComponent(roseThemeStorageKey(userId)) + '=';
    const cookie = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(key));
    const value = cookie?.slice(key.length);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

export function readStoredRoseDark(userId: string | null): boolean {
  return readStoredRoseChoice(userId) === 'dark';
}

/** Best-effort: without storage (private mode / quota) the choice lasts this session. */
export function writeStoredRoseDark(userId: string, dark: boolean): void {
  const choice: RoseThemeChoice = dark ? 'dark' : 'light';
  setItem(roseThemeStorageKey(userId), choice);
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${encodeURIComponent(roseThemeStorageKey(userId))}=${choice}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* Local storage remains available when browser cookies are blocked. */
  }
}
