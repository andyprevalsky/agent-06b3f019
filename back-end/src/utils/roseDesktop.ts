/**
 * Rose Desktop flag (server-side mirror of `front-end/src/lib/roseDesktop.ts`).
 *
 * The new Rose UI (apps, inline user views, pinned questions, the per-user
 * rose_user_ui) is on only for the accounts below. Agent-visible surfaces that
 * only make sense with that UI are assembled for flagged accounts only, so a
 * deploy is a no-op for every other account on those surfaces:
 *
 *   isRoseDesktopUser(userId)
 *     ├─ true  → rose_user_ui + rose-ui CLI in code sessions, the code-agent
 *     │          "Rose app UI" instructions, pinned questions, inline views
 *     └─ false → the stock code-agent prompt and workspace
 *
 * A code-reviewed constant, mirrored by `agents/utils/rose_desktop.py`;
 * `src/tests/structural/rose-desktop-flag-sync.test.ts` keeps the backend,
 * agents and front-end lists equal. This is the one backend list: the
 * Rose-in-Rose 403 gate (`utils/roseDevAccess.ts`) delegates here, and new
 * Rose Desktop surfaces (apps/preview) gate on `isRoseDesktopUser` too.
 */

export const ROSE_DESKTOP_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
];

export function isRoseDesktopUser(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId !== '' && ROSE_DESKTOP_USER_IDS.includes(userId);
}
