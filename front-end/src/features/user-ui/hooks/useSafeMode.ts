/**
 * Safe mode: host-owned escape hatch that user UI cannot override.
 *
 *   ?rose_safe=1          → on (persisted for this tab)
 *   ?rose_safe=0          → off (clears the persisted flag)
 *   Cmd/Ctrl + Shift + .  → toggle (persisted for this tab)
 *   SafeModeControl       → toggle (fixed corner button outside every iframe)
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getSessionItem, removeSessionItem, setSessionItem } from '@/lib/storage';
import { getQueryParams } from '@/lib/url';

import { SAFE_MODE_QUERY_PARAM, SAFE_MODE_STORAGE_KEY } from '../config';

export function readInitialSafeMode(): boolean {
  const fromQuery =
    typeof window === 'undefined' ? null : getQueryParams().get(SAFE_MODE_QUERY_PARAM);
  if (fromQuery === '1') {
    setSessionItem(SAFE_MODE_STORAGE_KEY, '1');
    return true;
  }
  if (fromQuery === '0') {
    removeSessionItem(SAFE_MODE_STORAGE_KEY);
    return false;
  }
  return getSessionItem(SAFE_MODE_STORAGE_KEY) === '1';
}

export function isSafeModeShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return false;
  return event.code === 'Period' || event.key === '.' || event.key === '>';
}

export function useSafeMode(): [boolean, (on: boolean) => void] {
  const [safeMode, setSafeModeState] = useState(readInitialSafeMode);
  // Only setSafeMode changes the state, so it keeps this ref in sync.
  const safeModeRef = useRef(safeMode);

  const setSafeMode = useCallback((on: boolean) => {
    if (on) setSessionItem(SAFE_MODE_STORAGE_KEY, '1');
    else removeSessionItem(SAFE_MODE_STORAGE_KEY);
    safeModeRef.current = on;
    setSafeModeState(on);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSafeModeShortcut(event)) return;
      event.preventDefault();
      setSafeMode(!safeModeRef.current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [setSafeMode]);

  return [safeMode, setSafeMode];
}
