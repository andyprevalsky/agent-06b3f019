/**
 * Config for the atlas-password-modal feature.
 *
 * Centralizes constants shared across layers so components/hooks never
 * inline magic strings.
 */

import type { AtlasPasswordSyncType } from './types';

/**
 * Keychain entry name that Atlas (ChatGPT Desktop) uses for its Safe
 * Storage secret. Passed to `window.api.openKeychainAccess` to preselect
 * the correct row in Keychain Access.
 */
export const ATLAS_KEYCHAIN_SEARCH_QUERY = 'ChatGPT Safe Storage';

/** Default sync-type used when the consumer omits the prop. */
export const DEFAULT_SYNC_TYPE: AtlasPasswordSyncType = 'cookies';
