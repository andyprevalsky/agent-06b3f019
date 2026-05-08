/**
 * Auth feature — configuration constants.
 *
 * Env reads, defaults, and magic values live here.
 * May import from own types only.
 */

import { BACKEND_BASE_URL } from '@/lib/backendUrl';

/** Backend API base URL (no trailing slash). */
export const AUTH_API_BASE_URL = BACKEND_BASE_URL;

/** Whether the auth feature should auto-login with dev credentials on boot. */
export const IS_DEV_AUTO_LOGIN = import.meta.env.DEV && !import.meta.env.VITEST;
