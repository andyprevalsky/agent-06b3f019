/**
 * Repo layer for the auth domain.
 *
 * Wraps the sole side-effecting boundary for local session state — an
 * `electron-store` instance keyed by `AUTH_STORE_NAME` and encrypted with
 * the shared config's `encryptionKey`. Keeps the Store import + instantiation
 * isolated so the service layer stays framework-agnostic and the tests can
 * stub `electron-store` at the module boundary.
 */

import Store from 'electron-store';
import { config } from '../../base/config';
import { AUTH_STORE_NAME } from './config';
import type { AuthSession } from './types';

interface AuthStoreSchema {
  session: AuthSession | null;
}

const store = new Store<AuthStoreSchema>({
  name: AUTH_STORE_NAME,
  encryptionKey: config.encryptionKey,
  clearInvalidConfig: true,
});

/**
 * Read the persisted session blob. Returns null when no session has ever
 * been stored (matching the declared `AuthSession | null` store schema).
 */
export function readSession(): AuthSession | null {
  const value = store.get('session');
  return value ?? null;
}

/** Persist a session blob to the encrypted electron-store file. */
export function writeSession(session: AuthSession): void {
  store.set('session', session);
}

/** Delete the persisted session blob. */
export function deleteSession(): void {
  store.delete('session');
}
