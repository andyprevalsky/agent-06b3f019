/**
 * STATE MACHINE: RoseThemeProvider — see ../hooks.ts for the full diagram.
 *
 *   inactive (not Rose Desktop / no user) → [STOCK], html untouched
 *   app login → smooth [DARK] once per identity; manual toggle remains available
 *   active   → [LIGHT] <--toggle()--> [DARK]; the stored choice is re-read
 *              whenever the signed-in account changes
 *   [DARK] mounted   → adds html.dark
 *   [DARK] unmounted / → removes html.dark (also when index.html's pre-paint
 *     script set it early; a signed-in light/stock account clears that early class)
 *     theme or user changes
 *
 * COLOR TRANSITION: manual and login changes ease the painted colors.
 * Theme state remains synchronous: the class flips in an insertion effect, i.e. inside the same
 * commit that re-renders the themed layers and BEFORE any of their layout
 * effects, so canvases that redraw synchronously on theme change already see
 * the new html.dark. Everything lands on one frame (no next-tick repaint).
 */

import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import { setItem } from '@/lib/storage';

import { ROSE_THEME_ACTIVE_KEY } from '../config';
import { RoseThemeContext, readStoredRoseDark, writeStoredRoseDark } from '../hooks';
import type { RoseThemeValue } from '../types';
import { useThemeTransition } from '../hooks/useThemeTransition';
import { useLoginDarkMode } from '../hooks/useLoginDarkMode';

interface ToggledChoice {
  userId: string;
  dark: boolean;
}

export function RoseThemeProvider({
  userId,
  children,
  darkOnLogin = false,
}: {
  /** The signed-in account; null keeps the stock (light) UI. */
  userId: string | null;
  children: ReactNode;
  /** The authenticated app enables the login transition; isolated views keep their theme. */
  darkOnLogin?: boolean;
}) {
  const roseDesktop = useRoseDesktop();
  const activeUserId = roseDesktop && userId ? userId : null;
  const storedDark = useMemo(() => readStoredRoseDark(activeUserId), [activeUserId]);
  const [toggled, setToggled] = useState<ToggledChoice | null>(null);
  const isDark =
    activeUserId !== null && (toggled?.userId === activeUserId ? toggled.dark : storedDark);

  const beginTransition = useThemeTransition();
  const toggle = useCallback(() => {
    if (activeUserId === null) return;
    const next = !isDark;
    beginTransition(() => {
      writeStoredRoseDark(activeUserId, next);
      setToggled({ userId: activeUserId, dark: next });
    });
  }, [activeUserId, isDark, beginTransition]);

  const applyLoginDark = useCallback((id: string) => {
    writeStoredRoseDark(id, true);
    setToggled({ userId: id, dark: true });
  }, []);
  useLoginDarkMode(darkOnLogin ? activeUserId : null, applyLoginDark);

  useEffect(() => {
    if (userId !== null) setItem(ROSE_THEME_ACTIVE_KEY, userId);
  }, [userId]);

  useInsertionEffect(() => {
    const root = document.documentElement;
    if (!isDark) {
      // The pre-paint script in index.html may have set html.dark early; drop it
      // once a signed-in account resolves to light. Signed-out/loading keeps it.
      if (userId !== null && root.hasAttribute('data-rose-predark')) {
        root.classList.remove('dark');
        root.removeAttribute('data-rose-predark');
      }
      return;
    }
    root.removeAttribute('data-rose-predark');
    if (root.classList.contains('dark')) return () => root.classList.remove('dark');
    root.classList.add('dark');
    return () => root.classList.remove('dark');
  }, [isDark, userId]);

  const value = useMemo<RoseThemeValue>(() => ({ isDark, toggle }), [isDark, toggle]);
  return <RoseThemeContext.Provider value={value}>{children}</RoseThemeContext.Provider>;
}
