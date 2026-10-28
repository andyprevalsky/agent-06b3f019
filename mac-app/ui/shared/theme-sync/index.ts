/**
 * Cross-window theme sync for the Mac app.
 *
 * STATE MACHINE (per BrowserWindow):
 *   main window:  html.dark toggled by RoseThemeProvider
 *                   --MutationObserver--> localStorage[MIRRORED_THEME_KEY] = 'dark' | 'light'
 *   launcher:     mount / 'storage' event / window focus
 *                   --read key--> html.dark on ('dark') | off (anything else)
 *
 * The Quick-Query launcher is a separate BrowserWindow (own document), so the
 * main window's html.dark never reaches it. Both windows load from the same
 * origin and Electron session, so they share localStorage and receive each
 * other's 'storage' events; the launcher then themes itself with the same
 * html.dark class the main window uses.
 */

import { getItem, setItem } from '@/lib/storage';

export const MIRRORED_THEME_KEY = 'rose-theme:active-window';

const isDocumentDark = (): boolean => document.documentElement.classList.contains('dark');

/**
 * Main window: mirror html.dark changes into shared storage; returns a
 * disposer. html.dark lands only after sign-in, so startup keeps the last
 * mirrored value (no light flash in the launcher) and seeds only a missing key.
 */
export const mirrorDocumentTheme = (): (() => void) => {
  const write = (): void => setItem(MIRRORED_THEME_KEY, isDocumentDark() ? 'dark' : 'light');
  if (getItem(MIRRORED_THEME_KEY) === null) write();
  const observer = new MutationObserver(write);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

/** Launcher: follow the main window's mirrored theme; returns a disposer. */
export const followMirroredTheme = (): (() => void) => {
  const apply = (): void => {
    document.documentElement.classList.toggle('dark', getItem(MIRRORED_THEME_KEY) === 'dark');
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === MIRRORED_THEME_KEY) apply();
  };
  apply();
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', apply);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', apply);
  };
};
