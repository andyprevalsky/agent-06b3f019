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
  try {
    return getStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): void {
  try {
    getStore()?.setItem(key, value);
  } catch {
    // Swallow SecurityError / QuotaExceededError — storage is best-effort.
  }
}

export function removeItem(key: string): void {
  try {
    getStore()?.removeItem(key);
  } catch {
    // Swallow SecurityError — storage is best-effort.
  }
}

function getSessionStore(): Storage | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage;
}

/** Tab-scoped (sessionStorage) variant of getItem. */
export function getSessionItem(key: string): string | null {
  try {
    return getSessionStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Tab-scoped (sessionStorage) variant of setItem. */
export function setSessionItem(key: string, value: string): void {
  try {
    getSessionStore()?.setItem(key, value);
  } catch {
    // Swallow SecurityError / QuotaExceededError — storage is best-effort.
  }
}

/** Tab-scoped (sessionStorage) variant of removeItem. */
export function removeSessionItem(key: string): void {
  try {
    getSessionStore()?.removeItem(key);
  } catch {
    // Swallow SecurityError — storage is best-effort.
  }
}
