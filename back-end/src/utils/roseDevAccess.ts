/** Developer publishing stays restricted independently of the general UI rollout. */
import { ROSE_DESKTOP_USER_IDS } from './roseDesktop';

export const ROSE_DEV_USER_IDS: readonly string[] = ROSE_DESKTOP_USER_IDS;

export function isRoseDevUser(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId !== '' && ROSE_DEV_USER_IDS.includes(userId);
}

/** 403 body for a dev-only route. */
export const ROSE_DEV_ONLY_BODY = {
  error: 'Rose-in-Rose is limited to Rose dev accounts',
  code: 'ROSE_DEV_ONLY',
} as const;
