/**
 * Local stand-in for FE-4's `useRoseTheme()` (features/rose-theme), coded to
 * the same signature `{ isDark, toggle }`. At integration this module becomes a
 * re-export of the real hook (that cross-feature import needs a
 * KNOWN_VIOLATIONS entry in tests/structural/structural-deps.test.ts, or the
 * hook moves under src/hooks/). Until then it only flips the `dark` class on
 * <html>, which the Rose Desktop `dark:` tokens key off.
 */

import { useCallback, useState } from 'react';

export interface RoseTheme {
  isDark: boolean;
  toggle: () => void;
}

export function useRoseTheme(): RoseTheme {
  const [isDark, setIsDark] = useState(() =>
    typeof document === 'undefined' ? false : document.documentElement.classList.contains('dark'),
  );
  const toggle = useCallback(() => {
    setIsDark((prev) => {
      document.documentElement.classList.toggle('dark', !prev);
      return !prev;
    });
  }, []);
  return { isDark, toggle };
}
