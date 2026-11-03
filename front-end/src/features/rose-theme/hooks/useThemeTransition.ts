/** Crossfade a whole theme frame, including canvases; color easing is the fallback. */
import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

export function useThemeTransition() {
  const finish = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef<{ skipTransition: () => void } | null>(null);
  useEffect(
    () => () => {
      clearTimeout(finish.current);
      active.current?.skipTransition();
      document.documentElement.classList.remove(
        'rose-login-theme-transition',
        'rose-theme-crossfade',
      );
    },
    [],
  );
  return useCallback((apply: () => void) => {
    clearTimeout(finish.current);
    active.current?.skipTransition();
    const root = document.documentElement;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.classList.remove('rose-login-theme-transition', 'rose-theme-crossfade');
      apply();
      return;
    }
    if (document.startViewTransition) {
      root.classList.add('rose-theme-crossfade');
      const transition = document.startViewTransition(() => flushSync(apply));
      active.current = transition;
      void transition.finished
        .catch(() => {})
        .finally(() => {
          if (active.current !== transition) return;
          active.current = null;
          root.classList.remove('rose-theme-crossfade');
        });
      return;
    }
    root.classList.add('rose-login-theme-transition');
    void getComputedStyle(root).backgroundColor;
    apply();
    finish.current = setTimeout(() => root.classList.remove('rose-login-theme-transition'), 480);
  }, []);
}
