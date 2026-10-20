/**
 * Rose dev accounts: the server-side allowlist for Rose-in-Rose (A1) and other
 * Rose Desktop surfaces whose backend must refuse everyone else (403).
 *
 * There is one backend list: this module delegates to the Rose Desktop flag
 * (`utils/roseDesktop.ts`), which mirrors the front-end
 * (`front-end/src/lib/roseDesktop.ts`) and agents lists;
 * `src/tests/structural/rose-desktop-flag-sync.test.ts` fails the build on drift.
 */
import { ROSE_DESKTOP_USER_IDS, isRoseDesktopUser } from './roseDesktop';

export const ROSE_DEV_USER_IDS: readonly string[] = ROSE_DESKTOP_USER_IDS;

export const isRoseDevUser: (userId: string | null | undefined) => boolean = isRoseDesktopUser;

/** 403 body for a dev-only route. */
export const ROSE_DEV_ONLY_BODY = {
  error: 'Rose-in-Rose is limited to Rose dev accounts',
  code: 'ROSE_DEV_ONLY',
} as const;
