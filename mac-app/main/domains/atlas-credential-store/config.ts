/**
 * Configuration constants for the atlas-credential-store domain.
 *
 * The credential file lives under Electron's `userData` directory, next to
 * the other app state. The filename intentionally uses `.enc` so it's clear
 * from the filesystem that the contents are opaque ciphertext.
 */

/** Filename of the encrypted Atlas keychain credential file under `userData`. */
export const CREDENTIAL_FILE = 'atlas-keychain.enc';

/** Log prefix used by every console log/error in this domain. */
export const LOG_PREFIX = '[AtlasCredentialStore]';
