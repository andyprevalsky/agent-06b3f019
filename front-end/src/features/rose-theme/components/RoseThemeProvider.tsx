/**
 * STATE MACHINE: RoseThemeProvider — see ../hooks.ts for the full diagram.
 *
 *   inactive (not Rose Desktop / no user) → [STOCK], html untouched
 *   active   → [LIGHT] <--toggle()--> [DARK]; the stored choice is re-read
 *              whenever the signed-in account changes
 *   [DARK] mounted   → adds html.dark
 *   [DARK] unmounted / → removes only the html.dark it added
 *     theme or user changes
 *
 * INSTANT SWITCH: the class flips in an insertion effect, i.e. inside the same
 * commit that re-renders the themed layers and BEFORE any of their layout
 * effects, so canvases that redraw synchronously on theme change already see
 * the new html.dark. Everything lands on one frame (no next-tick repaint).
 */

import { useCallback, useInsertionEffect, useMemo, useState, type ReactNode } from 'react';

import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import { RoseThemeContext, readStoredRoseDark, writeStoredRoseDark } from '../hooks';
import type { RoseThemeValue } from '../types';

interface ToggledChoice {
  userId: string;
  dark: boolean;
}

export function RoseThemeProvider({
  userId,
  children,
}: {
  /** The signed-in account; null keeps the stock (light) UI. */
  userId: string | null;
  children: ReactNode;
}) {
  const roseDesktop = useRoseDesktop();
  const activeUserId = roseDesktop && userId ? userId : null;
  const storedDark = useMemo(() => readStoredRoseDark(activeUserId), [activeUserId]);
  const [toggled, setToggled] = useState<ToggledChoice | null>(null);
  const isDark =
    activeUserId !== null && (toggled?.userId === activeUserId ? toggled.dark : storedDark);

  const toggle = useCallback(() => {
    if (activeUserId === null) return;
    const next = !isDark;
    writeStoredRoseDark(activeUserId, next);
    setToggled({ userId: activeUserId, dark: next });
  }, [activeUserId, isDark]);

  useInsertionEffect(() => {
    if (!isDark) return;
    const root = document.documentElement;
    if (root.classList.contains('dark')) return;
    root.classList.add('dark');
    return () => root.classList.remove('dark');
  }, [isDark]);

  const value = useMemo<RoseThemeValue>(() => ({ isDark, toggle }), [isDark, toggle]);
  return <RoseThemeContext.Provider value={value}>{children}</RoseThemeContext.Provider>;
}
