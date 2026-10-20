/**
 * Repo-relative path rules for project env/config files. Shared by the REST
 * validation and the session restore, so a path the API accepted can never
 * escape the checkout when it is written.
 */

export const MAX_PROJECT_PATH_LENGTH = 300;

/** Normalized repo-relative path, or null when unsafe. */
export function normalizeProjectPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
  if (trimmed === '' || trimmed.length > MAX_PROJECT_PATH_LENGTH) return null;
  if (trimmed.startsWith('/') || trimmed.includes('\0')) return null;
  const parts = trimmed.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '..')) return null;
  if (parts[0] === '.git' || parts.includes('.git')) return null;
  return parts.join('/');
}
