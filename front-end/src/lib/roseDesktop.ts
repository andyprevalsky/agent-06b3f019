/** Rose Desktop is the default UI for every visitor, including signed-out sessions. */
export const ROSE_DESKTOP_ENABLED_BY_DEFAULT = true;

/** Original pilot accounts, retained as shared account fixtures; no longer a UI allowlist. */
export const ROSE_DESKTOP_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
];

/** UI availability is independent of authentication and account feature flags. */
export function isRoseDesktopUser(
  _user: { id?: string; is_anonymous?: boolean } | null | undefined,
): boolean {
  return true;
}
