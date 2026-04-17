/**
 * Canonical localStorage wrapper. Domain code must import from here instead of
 * accessing `localStorage` / `sessionStorage` directly — enforced via the
 * `no-restricted-syntax` ESLint rule.
 *
 * SSR-safe: returns null / no-ops when `localStorage` is unavailable.
 */

function getStore(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

export function getItem(key: string): string | null {
  return getStore()?.getItem(key) ?? null;
}

export function setItem(key: string, value: string): void {
  getStore()?.setItem(key, value);
}

export function removeItem(key: string): void {
  getStore()?.removeItem(key);
}
