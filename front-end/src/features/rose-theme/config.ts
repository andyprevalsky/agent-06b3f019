/** localStorage key prefix; the full key is `rose-theme:<userId>`. */
export const ROSE_THEME_STORAGE_PREFIX = 'rose-theme:';

/** Per-user key holding 'dark' | 'light'. */
export function roseThemeStorageKey(userId: string): string {
  return `${ROSE_THEME_STORAGE_PREFIX}${userId}`;
}

/** localStorage key holding the last-active account id (read by index.html's pre-paint script). */
export const ROSE_THEME_ACTIVE_KEY = 'rose-theme-active';
