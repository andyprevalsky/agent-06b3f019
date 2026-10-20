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

export function readStoredRoseDark(userId: string | null): boolean {
  if (userId === null) return false;
  return getItem(roseThemeStorageKey(userId)) === 'dark';
}

/** Best-effort: without storage (private mode / quota) the choice lasts this session. */
export function writeStoredRoseDark(userId: string, dark: boolean): void {
  const choice: RoseThemeChoice = dark ? 'dark' : 'light';
  setItem(roseThemeStorageKey(userId), choice);
}
