/** Switch once per authenticated identity; manual changes remain usable afterward. */
import { useEffect, useRef } from 'react';

export function useLoginDarkMode(userId: string | null, applyDark: (userId: string) => void) {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const changed = previous.current !== userId;
    if (!userId) {
      previous.current = null;
      return;
    }
    if (!changed) return;
    const root = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let finish: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      previous.current = userId;
      applyDark(userId);
    };
    if (reduced) apply();
    else {
      root.classList.add('rose-login-theme-transition');
      // Commit the starting colors before the dark styles are applied.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          apply();
          finish = setTimeout(() => root.classList.remove('rose-login-theme-transition'), 450);
        });
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(finish);
      root.classList.remove('rose-login-theme-transition');
    };
  }, [userId, applyDark]);
}
