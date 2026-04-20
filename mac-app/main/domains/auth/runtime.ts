/**
 * Runtime layer for the auth domain.
 *
 * Exposes the static `AuthService` facade that IPC handlers, other domains,
 * and tests invoke. Keeps the public surface identical to the pre-refactor
 * flat file so the legacy `main/services/auth.ts` shim can re-export it
 * without behavior changes.
 */

import * as service from './service';
import type { AuthSession } from './types';

export class AuthService {
  /**
   * Read the persisted session. Auto-normalizes legacy seconds-precision
   * expires_at and transparently refreshes an expiring token.
   */
  static getSession(): Promise<AuthSession | null> {
    return service.getSession();
  }

  /** Persist a session, normalizing expires_at to milliseconds. */
  static setSession(session: AuthSession): void {
    service.setSession(session);
  }

  /** Wipe any persisted session blob. */
  static clearSession(): void {
    service.clearSession();
  }
}
