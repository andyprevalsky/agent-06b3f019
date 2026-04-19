/**
 * IPC wrappers for the atlas-password-modal feature — the sole consumer of
 * the `window.api.openKeychainAccess` surface for this feature. Hooks call
 * these; components never touch `window.api` directly.
 */

import { ATLAS_KEYCHAIN_SEARCH_QUERY } from './config';

export const openAtlasKeychainEntry = (): Promise<{ success: boolean }> =>
  window.api.openKeychainAccess(ATLAS_KEYCHAIN_SEARCH_QUERY);
